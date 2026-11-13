/**
 * Material period estimate in metres. Material space is y-up with its origin at the image's bottom-left texel
 * (R5): `phaseY` is measured from the image bottom, `phaseX` from the left. A phase is the position of the
 * CENTRE of a joint band, so a rect that starts on a joint starts mid-mortar and both neighbours get half a joint.
 * `phaseX` belongs to the course that sits on the joint at `phaseY`.
 */
export interface PeriodEstimate {
  x: number | null;
  y: number | null;
  phaseX: number;
  phaseY: number;
  /** 0..1: normalised prominence of the chosen autocorrelation peak (Y's when found, else X's; 0 when none). */
  confidence: number;
}

const MIN_PROMINENCE = 0.2;

interface Peak { lag: number; prominence: number }

/**
 * First autocorrelation peak of a periodic (wrapping) profile whose normalised prominence exceeds 0.2.
 * Prominence is measured against the higher of the two valleys down to the nearest higher sample on each side,
 * normalised by the autocorrelation's range (1 − min).
 */
function findPeriod(profile: Float64Array): Peak | null {
  const n = profile.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += profile[i];
  mean /= n;
  const p = new Float64Array(n);
  let energy = 0;
  for (let i = 0; i < n; i++) {
    p[i] = profile[i] - mean;
    energy += p[i] * p[i];
  }
  if (energy < 1e-12) return null;
  const ac = new Float64Array(n + 1);
  for (let lag = 0; lag <= n; lag++) {
    if (lag > n / 2) {
      ac[lag] = ac[n - lag];
      continue;
    }
    let s = 0;
    for (let i = 0; i < n; i++) s += p[i] * p[(i + lag) % n];
    ac[lag] = s / energy;
  }
  let acMin = Infinity;
  for (let i = 0; i <= n; i++) acMin = Math.min(acMin, ac[i]);
  const range = 1 - acMin;
  if (range <= 1e-9) return null;

  for (let lag = 2; lag <= Math.floor(n / 2); lag++) {
    if (!(ac[lag] > ac[lag - 1] && ac[lag] >= ac[lag + 1])) continue;
    let leftMin = ac[lag];
    for (let i = lag - 1; i >= 0 && ac[i] <= ac[lag]; i--) leftMin = Math.min(leftMin, ac[i]);
    let rightMin = ac[lag];
    for (let i = lag + 1; i <= n && ac[i] <= ac[lag]; i++) rightMin = Math.min(rightMin, ac[i]);
    const prominence = (ac[lag] - Math.max(leftMin, rightMin)) / range;
    if (prominence <= MIN_PROMINENCE) continue;
    // Parabolic refinement of the peak position.
    const a = ac[lag - 1], b = ac[lag], c = ac[lag + 1];
    const den = a - 2 * b + c;
    const delta = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
    return { lag: lag + delta, prominence: Math.min(1, prominence) };
  }
  return null;
}

/** Centre (px, texel-centre convention, in [0, period)) of the joint band of a periodic joint profile. */
function jointCentre(profile: Float64Array, period: number): number {
  let lo = Infinity;
  for (const v of profile) lo = Math.min(lo, v);
  let sx = 0, sy = 0;
  for (let i = 0; i < profile.length; i++) {
    const wgt = profile[i] - lo;
    const theta = (2 * Math.PI * (i + 0.5)) / period;
    sx += wgt * Math.cos(theta);
    sy += wgt * Math.sin(theta);
  }
  const angle = Math.atan2(sy, sx);
  const pos = (angle / (2 * Math.PI)) * period;
  return ((pos % period) + period) % period;
}

/** Joint fraction per row, indexed y-up (index 0 = bottom row). */
function rowProfile(mask: Uint8Array, w: number, h: number): Float64Array {
  const prof = new Float64Array(h);
  for (let r = 0; r < h; r++) {
    let s = 0;
    for (let x = 0; x < w; x++) s += mask[r * w + x];
    prof[h - 1 - r] = s / w;
  }
  return prof;
}

/** Joint fraction per column over the y-up rows `v` in [v0, v1) (wrapping). */
function columnProfile(mask: Uint8Array, w: number, h: number, v0: number, v1: number): Float64Array {
  const prof = new Float64Array(w);
  let rows = 0;
  for (let v = v0; v < v1; v++) {
    const r = h - 1 - (((v % h) + h) % h);
    for (let x = 0; x < w; x++) prof[x] += mask[r * w + x];
    rows++;
  }
  if (rows > 0) for (let x = 0; x < w; x++) prof[x] /= rows;
  return prof;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Period and phase of a joint mask (1 = joint, row 0 = top). Y comes from the autocorrelation of the per-row
 * joint fraction. X comes from per-course column profiles (the middle half of each course, between joint
 * centres), taking the median of their peaks; because each course is measured on its own, a running bond yields
 * the brick period, not the half-brick offset. Without a Y period the whole image is one profile.
 */
export function estimatePeriod(
  mask: Uint8Array, w: number, h: number, tileSizeM: [number, number],
): PeriodEstimate {
  const mppX = tileSizeM[0] / w, mppY = tileSizeM[1] / h;
  const rows = rowProfile(mask, w, h);
  const py = findPeriod(rows);
  let phaseYpx = 0;
  let px: Peak | null = null;
  let phaseXpx = 0;

  if (py) {
    phaseYpx = jointCentre(rows, py.lag);
    const courses = Math.max(1, Math.round(h / py.lag));
    const lags: number[] = [];
    const proms: number[] = [];
    let firstCourse: Float64Array | null = null;
    for (let k = 0; k < courses; k++) {
      const start = phaseYpx + k * py.lag;
      const prof = columnProfile(mask, w, h, Math.round(start + py.lag / 4), Math.round(start + (3 * py.lag) / 4));
      if (k === 0) firstCourse = prof;
      const peak = findPeriod(prof);
      if (peak) {
        lags.push(peak.lag);
        proms.push(peak.prominence);
      }
    }
    if (lags.length > 0) {
      px = { lag: median(lags), prominence: median(proms) };
      phaseXpx = jointCentre(firstCourse!, px.lag);
    }
  } else {
    const cols = columnProfile(mask, w, h, 0, h);
    px = findPeriod(cols);
    if (px) phaseXpx = jointCentre(cols, px.lag);
  }

  return {
    x: px ? px.lag * mppX : null,
    y: py ? py.lag * mppY : null,
    phaseX: px ? phaseXpx * mppX : 0,
    phaseY: py ? phaseYpx * mppY : 0,
    confidence: py ? py.prominence : px ? px.prominence : 0,
  };
}

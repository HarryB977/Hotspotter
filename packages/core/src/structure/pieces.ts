import type { GrayImage } from './analyze';

export interface OtsuResult {
  /** Joint threshold: pixels with value < threshold are joints. */
  threshold: number;
  /** Otsu effectiveness σB² / σT², 0..1. ≈ 1 for two clean levels, ≈ 0.64 for Gaussian-like noise. */
  separability: number;
}

const BINS = 256;

/** Otsu's threshold over a 256-bin histogram of 0..1 values. Ties (flat σB² plateaus) take the plateau middle. */
export function otsu(img: GrayImage): OtsuResult {
  const hist = new Float64Array(BINS);
  const n = img.data.length;
  for (let i = 0; i < n; i++) hist[Math.min(BINS - 1, Math.max(0, Math.floor(img.data[i] * BINS)))]++;
  let total = 0;
  for (let b = 0; b < BINS; b++) total += b * hist[b];
  const mean = total / n;
  let varT = 0;
  for (let b = 0; b < BINS; b++) varT += hist[b] * (b - mean) ** 2;
  varT /= n;
  if (varT === 0) return { threshold: 0, separability: 0 };

  const between = new Float64Array(BINS);
  let w0 = 0, sum0 = 0, best = 0;
  for (let k = 0; k < BINS - 1; k++) {
    w0 += hist[k];
    sum0 += k * hist[k];
    const w1 = n - w0;
    if (w0 === 0 || w1 === 0) continue;
    const m0 = sum0 / w0, m1 = (total - sum0) / w1;
    between[k] = (w0 / n) * (w1 / n) * (m0 - m1) ** 2;
    if (between[k] > best) best = between[k];
  }
  let lo = -1, hi = -1;
  for (let k = 0; k < BINS - 1; k++) {
    if (between[k] >= best * (1 - 1e-9)) {
      if (lo < 0) lo = k;
      hi = k;
    } else if (lo >= 0) break;
  }
  const k = Math.floor((lo + hi) / 2);
  return { threshold: (k + 1) / BINS, separability: best / varT };
}

/** Joint mask (1 = joint): pixels darker than `threshold` (Otsu's when omitted). */
export function jointMask(img: GrayImage, threshold?: number): { mask: Uint8Array; threshold: number } {
  const t = threshold ?? otsu(img).threshold;
  const mask = new Uint8Array(img.data.length);
  for (let i = 0; i < mask.length; i++) mask[i] = img.data[i] < t ? 1 : 0;
  return { mask, threshold: t };
}

/**
 * Hysteresis joint mask (1 = joint): pixels with `value < growBelow` that are 4-connected (with wrap) to a seed
 * pixel with `value < seedBelow`. Isolated pits are dropped: components smaller than `minComponentPx` whose
 * bounding box is also shorter than `minExtentPx` on both axes (short dashes of a mortar line are kept).
 */
export function hysteresisJointMask(
  img: GrayImage, seedBelow: number, growBelow: number, minComponentPx: number, minExtentPx: number,
): Uint8Array {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const root = components(w, h, (i) => data[i] < growBelow);
  const seeded = new Uint8Array(n);
  const size = new Int32Array(n);
  const x0 = new Int32Array(n).fill(w), x1 = new Int32Array(n).fill(-1);
  const y0 = new Int32Array(n).fill(h), y1 = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const r = root[i];
    if (r < 0) continue;
    const x = i % w, y = (i - x) / w;
    size[r]++;
    if (data[i] < seedBelow) seeded[r] = 1;
    x0[r] = Math.min(x0[r], x); x1[r] = Math.max(x1[r], x);
    y0[r] = Math.min(y0[r], y); y1[r] = Math.max(y1[r], y);
  }
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = root[i];
    if (r < 0 || !seeded[r]) continue;
    const extent = Math.max(x1[r] - x0[r], y1[r] - y0[r]) + 1;
    if (size[r] >= minComponentPx || extent >= minExtentPx) mask[i] = 1;
  }
  return mask;
}

/** Root index of each `open` pixel's 4-connected, wrapping component (-1 where not open). */
function components(w: number, h: number, open: (i: number) => boolean): Int32Array {
  const n = w * h;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = open(i) ? i : -1;
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (parent[i] < 0) continue;
      const right = y * w + ((x + 1) % w);
      const down = ((y + 1) % h) * w + x;
      if (parent[right] >= 0) union(i, right);
      if (parent[down] >= 0) union(i, down);
    }
  }
  const root = new Int32Array(n);
  for (let i = 0; i < n; i++) root[i] = parent[i] < 0 ? -1 : find(i);
  return root;
}

/**
 * Labels the non-joint regions of `mask` (4-connected, wrapping on both axes, so a piece cut by the image edge
 * is one piece). Pieces joined only through bridges up to 2·`splitRadiusPx` wide (gaps in a mortar line) are
 * split: seeds are the non-joint pixels farther than `splitRadiusPx` from any joint, and each seed region grows
 * back over its non-joint pixels (geodesic BFS). Regions too thin to hold a seed stay whole. Pieces smaller than
 * `minPiecePx` become joint (id 0). Ids 1..count in scan order.
 */
export function segmentPieces(
  mask: Uint8Array, w: number, h: number, minPiecePx = 16, splitRadiusPx = 8,
): { pieceId: Uint32Array; count: number } {
  const n = w * h;
  const free = new Uint32Array(n);
  for (let i = 0; i < n; i++) free[i] = mask[i] ? 0 : 1;
  const dist = jointDistance(free, w, h, [1, 1]);
  const seedRoot = components(w, h, (i) => free[i] === 1 && dist[i] > splitRadiusPx);
  const region = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = 0; i < n; i++) {
    if (seedRoot[i] >= 0) {
      region[i] = seedRoot[i];
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % w, y = (i - x) / w;
    const nb = [y * w + ((x + 1) % w), y * w + ((x + w - 1) % w), ((y + 1) % h) * w + x, ((y + h - 1) % h) * w + x];
    for (const j of nb) {
      if (free[j] === 1 && region[j] < 0) {
        region[j] = region[i];
        queue[tail++] = j;
      }
    }
  }
  const rest = components(w, h, (i) => free[i] === 1 && region[i] < 0);
  for (let i = 0; i < n; i++) if (rest[i] >= 0) region[i] = n + rest[i];

  const size = new Int32Array(2 * n);
  for (let i = 0; i < n; i++) if (region[i] >= 0) size[region[i]]++;
  const label = new Uint32Array(2 * n);
  const pieceId = new Uint32Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const r = region[i];
    if (r < 0 || size[r] < minPiecePx) continue;
    if (label[r] === 0) label[r] = ++count;
    pieceId[i] = label[r];
  }
  return { pieceId, count };
}

/** Squared-distance 1D lower envelope (Felzenszwalb & Huttenlocher) with sample spacing² `a`. */
function edt1d(f: Float64Array, n: number, a: number, out: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = -1;
  for (let q = 0; q < n; q++) {
    if (f[q] === Infinity) continue;
    const fq = f[q] + a * q * q;
    let s = -Infinity;
    while (k >= 0) {
      const p = v[k];
      s = (fq - (f[p] + a * p * p)) / (2 * a * (q - p));
      if (s > z[k]) break;
      k--;
    }
    k++;
    v[k] = q;
    z[k] = k === 0 ? -Infinity : s;
    z[k + 1] = Infinity;
  }
  if (k < 0) {
    out.fill(Infinity, 0, n);
    return;
  }
  let j = 0;
  for (let p = 0; p < n; p++) {
    while (z[j + 1] < p) j++;
    const d = p - v[j];
    out[p] = a * d * d + f[v[j]];
  }
}

/**
 * Exact Euclidean distance in metres from every pixel to the nearest joint pixel (pieceId 0), wrapping on both
 * axes (EDT on a 3×3 tiled copy, centre crop). 0 on joints. Clamped to the tile's longer side in metres (never
 * reached by a real wrapped distance, which is at most half the diagonal), so a map without joints holds that
 * value everywhere instead of +Infinity.
 */
export function jointDistance(
  pieceId: Uint32Array, w: number, h: number, metresPerPx: [number, number],
): Float32Array {
  const ax = metresPerPx[0] ** 2, ay = metresPerPx[1] ** 2;
  const maxDist = Math.max(w * metresPerPx[0], h * metresPerPx[1]);
  const maxN = 3 * Math.max(w, h);
  const f = new Float64Array(maxN), out = new Float64Array(maxN);
  const v = new Int32Array(maxN), z = new Float64Array(maxN + 1);
  // Rows of the 3×3 tiling repeat every h, so the x pass runs once per source row.
  const g = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < 3 * w; x++) f[x] = pieceId[y * w + (x % w)] === 0 ? 0 : Infinity;
    edt1d(f, 3 * w, ax, out, v, z);
    for (let x = 0; x < w; x++) g[y * w + x] = out[w + x];
  }
  const dist = new Float32Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < 3 * h; y++) f[y] = g[(y % h) * w + x];
    edt1d(f, 3 * h, ay, out, v, z);
    for (let y = 0; y < h; y++) dist[y * w + x] = Math.min(maxDist, Math.sqrt(out[h + y]));
  }
  return dist;
}

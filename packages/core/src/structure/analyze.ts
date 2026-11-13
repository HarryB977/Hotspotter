import { estimatePeriod } from './period';
import type { PeriodEstimate } from './period';
import { hysteresisJointMask, jointDistance, otsu, segmentPieces } from './pieces';

export interface GrayImage {
  width: number;
  height: number;
  /** 0..1, row 0 = top. */
  data: Float32Array;
}

export type MaterialType = 'pieces' | 'continuous' | 'directional';

export interface StructureResult {
  type: MaterialType;
  period: PeriodEstimate;
  /**
   * Segmentation threshold used, on the joint relief (1 = flush with the local surface, 0 = a full height range
   * below it): joints are pixels below it that connect to a deeper Otsu seed (or, with a user threshold, all
   * pixels below it). 0 = no joints.
   */
  threshold: number;
  /** Segmentation threshold derived from Otsu, reported even when the gates reject joints (UI suggestion). */
  suggestedThreshold: number;
  /** 0 = joint, ≥ 1 piece; same size as the input, row 0 = top. */
  pieceId: Uint32Array;
  /** Metres from the nearest joint pixel (wrap-around), 0 on joints, capped at max(tileSizeM) (the value everywhere without joints). */
  jointDistM: Float32Array;
  pieceCount: number;
  jointFraction: number;
  /** 0 isotropic … 1 fully directional. */
  anisotropy: number;
  grainAxis: 'x' | 'y' | null;
  width: number;
  height: number;
}

/**
 * Automatic joints need both a distinct joint level in the relief histogram (Otsu separability; noise and grain
 * sit at 0.69–0.73, bricks wall 13 at 0.77, clean joints at 1; a loose first filter) and joints deeper than this
 * fraction of the height range (joints 0.24–0.27, concrete and fBm 0.03–0.05; the discriminating test). Tuned on
 * samples/pbr and the synthetic materials.
 */
const MIN_SEPARABILITY = 0.7;
const MIN_JOINT_DEPTH = 0.1;
/**
 * Hysteresis: Otsu keeps only the deep grout core, leaving joints dashed. Joints grow from those seeds into
 * pixels at least this fraction of the Otsu depth below the surface: t_seg = 1 − (1 − t_otsu) · 0.38.
 */
const SEGMENT_DEPTH_RATIO = 0.38;
/**
 * Joint components smaller than this fraction of the image, and shorter than MIN_JOINT_EXTENT of the longer side
 * on both axes, are isolated pits, not joints. The extent rule keeps the dashes of a broken mortar line.
 */
const MIN_JOINT_COMPONENT = 0.0025;
const MIN_JOINT_EXTENT = 0.05;
/**
 * Pieces smaller than this fraction of the image (262 px at 512²) are crack slivers and chips, folded into the
 * joints. 0.2 % starts eating real bricks in bricks wall 13 and 0.3 % halves its X period.
 */
const MIN_PIECE = 0.001;
/** Analysis resolution: larger inputs are downsampled to this longer side. */
const MAX_ANALYSIS_SIDE = 512;
/** Closing radius of the joint relief, as a fraction of the longer side (10 px at 512). */
const RELIEF_RADIUS = 1 / 50;
/** Anisotropy from which a grain axis is reported. */
const MIN_GRAIN_ANISOTROPY = 0.3;

/** Grey image from RGBA8: `height` reads R; `invertedLuma` is 1 − Rec.709 luma (albedo-only materials). */
export function toGray(rgba: Uint8Array, w: number, h: number, mode: 'height' | 'invertedLuma'): GrayImage {
  const data = new Float32Array(w * h);
  for (let i = 0; i < data.length; i++) {
    const o = i * 4;
    data[i] = mode === 'height'
      ? rgba[o] / 255
      : 1 - (0.2126 * rgba[o] + 0.7152 * rgba[o + 1] + 0.0722 * rgba[o + 2]) / 255;
  }
  return { width: w, height: h, data };
}

/** Area-weighted 1D resample of `n` samples into `m` samples. */
function resample1d(src: Float32Array, n: number, m: number, out: Float32Array): void {
  const scale = n / m;
  for (let j = 0; j < m; j++) {
    const a = j * scale, b = (j + 1) * scale;
    let s = 0;
    for (let i = Math.floor(a); i < Math.min(n, Math.ceil(b)); i++) {
      const cover = Math.min(b, i + 1) - Math.max(a, i);
      s += src[i] * cover;
    }
    out[j] = s / scale;
  }
}

/** Box-filter downsample so the longer side is at most `maxSide`. Returns the input when already small enough. */
export function downsample(img: GrayImage, maxSide: number): GrayImage {
  const { width: w, height: h } = img;
  if (Math.max(w, h) <= maxSide) return img;
  const s = maxSide / Math.max(w, h);
  const nw = Math.max(1, Math.round(w * s)), nh = Math.max(1, Math.round(h * s));
  const tmp = new Float32Array(nw * h);
  const rowOut = new Float32Array(nw);
  for (let y = 0; y < h; y++) {
    resample1d(img.data.subarray(y * w, (y + 1) * w), w, nw, rowOut);
    tmp.set(rowOut, y * nw);
  }
  const data = new Float32Array(nw * nh);
  const col = new Float32Array(h), colOut = new Float32Array(nh);
  for (let x = 0; x < nw; x++) {
    for (let y = 0; y < h; y++) col[y] = tmp[y * nw + x];
    resample1d(col, h, nh, colOut);
    for (let y = 0; y < nh; y++) data[y * nw + x] = colOut[y];
  }
  return { width: nw, height: nh, data };
}

/** Separable wrapping max (dilate) or min (erode) over a (2r+1)² square. */
function morph(src: Float32Array, w: number, h: number, r: number, dilate: boolean): Float32Array {
  const pick = dilate ? Math.max : Math.min;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = src[y * w + x];
      for (let k = -r; k <= r; k++) m = pick(m, src[y * w + ((x + k + w * r) % w)]);
      tmp[y * w + x] = m;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = tmp[y * w + x];
      for (let k = -r; k <= r; k++) m = pick(m, tmp[((y + k + h * r) % h) * w + x]);
      out[y * w + x] = m;
    }
  }
  return out;
}

/**
 * Joint relief: 1 = flush with the local surface, lower = deeper below it, in units of the map's height range
 * (1st–99th percentile). It is 1 − black top-hat (closing − height) of the normalised map, so joints read the
 * same on tall and short pieces. The closing fills grooves narrower than ~2·radius.
 */
function jointRelief(img: GrayImage): GrayImage {
  const { width: w, height: h, data } = img;
  const sorted = Float32Array.from(data).sort();
  const lo = sorted[Math.floor(0.01 * (sorted.length - 1))], hi = sorted[Math.floor(0.99 * (sorted.length - 1))];
  const span = hi - lo;
  const norm = new Float32Array(w * h);
  if (span > 0) for (let i = 0; i < norm.length; i++) norm[i] = Math.min(1, Math.max(0, (data[i] - lo) / span));
  const r = Math.max(2, Math.round(Math.max(w, h) * RELIEF_RADIUS));
  const closed = morph(morph(norm, w, h, r, true), w, h, r, false);
  const relief = new Float32Array(w * h);
  for (let i = 0; i < relief.length; i++) relief[i] = 1 - (closed[i] - norm[i]);
  return { width: w, height: h, data: relief };
}

/** Averaged gradient structure tensor (wrapping central differences): anisotropy 1 − λmin/λmax and grain axis. */
function orientation(img: GrayImage): { anisotropy: number; grainAxis: 'x' | 'y' | null } {
  const { width: w, height: h, data } = img;
  let jxx = 0, jyy = 0, jxy = 0;
  for (let y = 0; y < h; y++) {
    const up = ((y + h - 1) % h) * w, dn = ((y + 1) % h) * w, row = y * w;
    for (let x = 0; x < w; x++) {
      const gx = data[row + ((x + 1) % w)] - data[row + ((x + w - 1) % w)];
      const gy = data[up + x] - data[dn + x];
      jxx += gx * gx;
      jyy += gy * gy;
      jxy += gx * gy;
    }
  }
  const tr = jxx + jyy;
  if (tr <= 0) return { anisotropy: 0, grainAxis: null };
  const root = Math.sqrt(((jxx - jyy) / 2) ** 2 + jxy * jxy);
  const lMax = tr / 2 + root, lMin = tr / 2 - root;
  const anisotropy = 1 - Math.max(0, lMin) / lMax;
  // Gradients run across the grain: mostly-vertical gradients mean grain along x.
  const grainAxis = anisotropy < MIN_GRAIN_ANISOTROPY ? null : jyy > jxx ? 'x' : 'y';
  return { anisotropy, grainAxis };
}

/** pieces if 3–45 % joints and ≥ 4 pieces; else directional if anisotropy ≥ 0.45; else continuous. */
export function proposeMaterialType(r: Omit<StructureResult, 'type'>): MaterialType {
  if (r.jointFraction >= 0.03 && r.jointFraction <= 0.45 && r.pieceCount >= 4) return 'pieces';
  if (r.anisotropy >= 0.45) return 'directional';
  return 'continuous';
}

/**
 * Structure of a tileable grey map (height, or inverted albedo luma), downsampled to ≤ 512 px when larger (the
 * result has the analysed size). Joints live on the joint relief (see `jointRelief`). Automatic: Otsu on the
 * relief decides whether there are joints (separability and depth gates) and seeds them; joints then grow to
 * the shallower `suggestedThreshold`. An explicit `threshold` is the segmentation threshold itself (no seeds).
 * Isolated pits (small, short joint components) are dropped either way.
 */
export function analyzeStructure(
  input: GrayImage, tileSizeM: [number, number], opts?: { threshold?: number },
): StructureResult {
  const img = downsample(input, MAX_ANALYSIS_SIDE);
  const { width: w, height: h } = img;
  const relief = jointRelief(img);
  const o = otsu(relief);
  const suggestedThreshold = 1 - (1 - o.threshold) * SEGMENT_DEPTH_RATIO;
  const minComponentPx = Math.ceil(MIN_JOINT_COMPONENT * w * h);
  const minExtentPx = Math.ceil(MIN_JOINT_EXTENT * Math.max(w, h));
  let threshold: number;
  let mask: Uint8Array;
  if (opts?.threshold !== undefined) {
    threshold = opts.threshold;
    mask = hysteresisJointMask(relief, threshold, threshold, minComponentPx, minExtentPx);
  } else if (o.separability >= MIN_SEPARABILITY && 1 - o.threshold >= MIN_JOINT_DEPTH) {
    threshold = suggestedThreshold;
    mask = hysteresisJointMask(relief, o.threshold, threshold, minComponentPx, minExtentPx);
  } else {
    threshold = 0;
    mask = new Uint8Array(w * h);
  }
  const { pieceId, count } = segmentPieces(mask, w, h, Math.ceil(MIN_PIECE * w * h));
  // Islands dropped by segmentPieces are joints too: period and fraction use the final joint set.
  let joints = 0;
  const finalMask = new Uint8Array(w * h);
  for (let i = 0; i < finalMask.length; i++) {
    if (pieceId[i] === 0) {
      finalMask[i] = 1;
      joints++;
    }
  }
  const { anisotropy, grainAxis } = orientation(img);
  const rest: Omit<StructureResult, 'type'> = {
    period: estimatePeriod(finalMask, w, h, tileSizeM),
    threshold,
    suggestedThreshold,
    pieceId,
    jointDistM: jointDistance(pieceId, w, h, [tileSizeM[0] / w, tileSizeM[1] / h]),
    pieceCount: count,
    jointFraction: joints / (w * h),
    anisotropy,
    grainAxis,
    width: w,
    height: h,
  };
  return { type: proposeMaterialType(rest), ...rest };
}

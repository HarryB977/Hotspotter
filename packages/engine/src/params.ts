import { DEFAULT_DIRT, DEFAULT_WEAR } from '@hotspotter/core';
import type { DirtParams, FamilyShape, GrooveProfile, GrooveSettings, WearFamily, WearParams } from '@hotspotter/core';
import commonWgsl from './shaders/common.wgsl?raw';

/** Prepends the shared WGSL prelude (Params, Wear, Rect and the noise utilities) to a shader module. */
export function withCommon(code: string): string {
  return `${commonWgsl}\n${code}`;
}

export const PROFILE_CODE: Record<GrooveProfile, number> = { bevel: 0, round: 1, step: 2, none: 3 };

export const PARAMS_BYTES = 64;

export interface ParamsInput {
  outW: number;
  outH: number;
  /** Output px per reference (layout) px. */
  refScale: number;
  /** Reference px per metre. */
  ppmRef: number;
  tileSizeM: [number, number];
  heightScaleM: number;
  groove: GrooveSettings;
  roughnessIsGloss: boolean;
  /** Layout height in reference px. */
  refHeightPx: number;
  sobelMacro: boolean;
  seed: number;
}

/**
 * Single source of the Params byte layout. Mirrors `struct Params` in
 * shaders/common.wgsl; keep both in sync.
 *
 *   byte  field
 *      0  outSize (vec2<f32>)
 *      8  refScale
 *     12  ppmRef
 *     16  tileSizeM (vec2<f32>)
 *     24  heightScaleM
 *     28  grooveWidthM
 *     32  grooveDepthM
 *     36  profile (u32)
 *     40  roughnessIsGloss (u32)
 *     44  refHeightPx
 *     48  sobelMacro (u32)
 *     52  bevelM
 *     56  seed (u32)
 *     60  pad
 */
export function packParams(p: ParamsInput): ArrayBuffer {
  const data = new ArrayBuffer(PARAMS_BYTES);
  const f = new Float32Array(data);
  const u = new Uint32Array(data);
  f[0] = p.outW;
  f[1] = p.outH;
  f[2] = p.refScale;
  f[3] = p.ppmRef;
  f[4] = p.tileSizeM[0];
  f[5] = p.tileSizeM[1];
  f[6] = p.heightScaleM;
  f[7] = p.groove.widthM;
  f[8] = p.groove.depthM;
  u[9] = PROFILE_CODE[p.groove.profile];
  u[10] = p.roughnessIsGloss ? 1 : 0;
  f[11] = p.refHeightPx;
  u[12] = p.sobelMacro ? 1 : 0;
  f[13] = p.groove.bevelM;
  u[14] = p.seed >>> 0;
  return data;
}

export const WEAR_BYTES = 128;

export interface WearExtra {
  /** The structure has joints; without them pieceId / jointDistM carry no information. */
  hasPieces: boolean;
  /** Material grain axis from the structure analysis. */
  grainAxis: 'x' | 'y' | null;
  /** A mask texture is bound; the mask applies only when this and `mask.enabled` are both set. */
  maskBound: boolean;
}

const GRAIN_CODE = { x: 1, y: 2 } as const;

export const FAMILY_CODE: Record<WearFamily, number> = {
  brittle: 0, chipping: 1, splinter: 2, erosion: 3, dent: 4, edgeOnly: 5,
};

/** Finite `v` clamped to [lo, hi], otherwise `fallback`. Saved docs do not type-check scalar fields. */
function num(v: unknown, fallback: number, lo = -Infinity, hi = Infinity): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

/**
 * Single source of the Wear byte layout (R17). Mirrors `struct Wear` in shaders/common.wgsl; keep both in sync.
 * Every field is a 4-byte scalar, so byte = index * 4. Unused trailing slots are reserved for the substrate fields.
 *
 *   byte  field                 byte  field
 *      0  enabled (u32)           52  hasPieces (u32)
 *      4  intensity               56  grainAxis (u32: 0 none, 1 x, 2 y)
 *      8  widthM                  60  cellMix
 *     12  minEdgeM                64  anisotropy
 *     16  sizeM                   68  steps (u32)
 *     20  depthM                  72  loses (u32)
 *     24  bandM                   76  polish
 *     28  microM                  80  cavity
 *     32  pieceBias               84  runoff
 *     36  edgeTone                88  runoffLengthM
 *     40  maskStrength            92  tint r, g, b (96, 100)
 *     44  maskEnabled (u32)      104  family (u32, FAMILY_CODE)
 *     48  maskInvert (u32)       108  reserved … 127
 *
 * Out-of-range or non-finite values fall back to DEFAULT_WEAR / DEFAULT_DIRT; the seed goes in Params.
 */
export function packWear(w: WearParams, d: DirtParams, shape: FamilyShape, extra: WearExtra): ArrayBuffer {
  const W = DEFAULT_WEAR;
  const D = DEFAULT_DIRT;
  const data = new ArrayBuffer(WEAR_BYTES);
  const f = new Float32Array(data);
  const u = new Uint32Array(data);
  const mask = w.mask ?? W.mask;
  u[0] = 1;
  f[1] = num(w.intensity, W.intensity, 0, 1);
  f[2] = num(w.widthM, W.widthM, 0);
  f[3] = num(w.minEdgeM, W.minEdgeM, 0);
  // sizeM divides the noise coordinates.
  f[4] = num(w.sizeM, W.sizeM, 1e-4);
  f[5] = num(w.depthM, W.depthM, 0);
  f[6] = num(w.bandM, W.bandM, 0);
  f[7] = num(w.microM, W.microM, 0);
  f[8] = num(w.pieceBias, W.pieceBias, 0, 1);
  f[9] = num(w.edgeTone, W.edgeTone, 0, 1);
  f[10] = num(mask.strength, W.mask.strength, 0, 1);
  u[11] = extra.maskBound && mask.enabled === true ? 1 : 0;
  u[12] = mask.invert === true ? 1 : 0;
  u[13] = extra.hasPieces ? 1 : 0;
  u[14] = extra.grainAxis ? GRAIN_CODE[extra.grainAxis] : 0;
  f[15] = num(shape.cellMix, 0, 0, 1);
  f[16] = num(shape.anisotropy, 1, 1);
  u[17] = Math.round(num(shape.steps, 0, 0, 255));
  u[18] = shape.loses ? 1 : 0;
  f[19] = num(shape.polish, 0, 0, 1);
  f[20] = num(d.cavity, D.cavity, 0, 1);
  f[21] = num(d.runoff, D.runoff, 0, 1);
  f[22] = num(d.runoffLengthM, D.runoffLengthM, 0);
  for (let i = 0; i < 3; i++) f[23 + i] = num(d.tint?.[i], D.tint[i], 0, 1);
  u[26] = FAMILY_CODE[w.family] ?? FAMILY_CODE[W.family];
  return data;
}

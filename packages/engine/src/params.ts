import type { GrooveProfile, GrooveSettings } from '@hotspotter/core';
import commonWgsl from './shaders/common.wgsl?raw';

/** Prepends the shared WGSL prelude (the Params declaration) to a shader module. */
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

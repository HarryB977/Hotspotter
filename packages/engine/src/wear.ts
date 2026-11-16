import { WEAR_FAMILIES } from '@hotspotter/core';
import type { DirtParams, WearParams } from '@hotspotter/core';
import {
  NO_DIRT, WEAR_BYTES, WEAR_F_BANDM, WEAR_F_RUNOFF, WEAR_F_RUNOFF_LENGTH, WEAR_U_LOSES, packNoWear, packWear, withCommon,
} from './params';
import type { WearExtra } from './params';
import { cached } from './pipelines';
import wearLossWgsl from './shaders/wearLoss.wgsl?raw';
import jfaWgsl from './shaders/jfa.wgsl?raw';
import wearCompositeWgsl from './shaders/wearComposite.wgsl?raw';
import colorCompositeWgsl from './shaders/colorComposite.wgsl?raw';

export interface WearUniforms {
  buffer: GPUBuffer;
  /** Sanitised bandM as packed (0 without wear). */
  bandM: number;
  /** How far below a loss its runoff reaches, metres: runoffLengthM when losses can tint (wear, a family that loses, runoff > 0), else 0. */
  lossRunoffM: number;
}

/**
 * The Wear uniform buffer (R17). Without wear `W.enabled` is 0 for every consumer and only the dirt fields are set:
 * dirt applies with and without wear. Without `dirt` there is none (cavity and runoff 0).
 */
export function createWearUniforms(
  device: GPUDevice, wear: WearParams | undefined, dirt: DirtParams | undefined, extra: WearExtra,
): WearUniforms {
  const d = dirt ?? NO_DIRT;
  const data = wear
    ? packWear(wear, d, WEAR_FAMILIES[wear.family] ?? WEAR_FAMILIES.brittle, extra)
    : packNoWear(d, extra.atlasHeightM);
  const buffer = device.createBuffer({ size: WEAR_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buffer, 0, data);
  const f = new Float32Array(data);
  const losesAndRuns = !!wear && new Uint32Array(data)[WEAR_U_LOSES] !== 0 && f[WEAR_F_RUNOFF] > 0;
  return { buffer, bandM: f[WEAR_F_BANDM], lossRunoffM: losesAndRuns ? f[WEAR_F_RUNOFF_LENGTH] : 0 };
}

export interface WearLossInput {
  wear: GPUBuffer;
  params: GPUBuffer;
  rects: GPUBuffer;
  rectId: GPUTexture;
  /** Atlas-space structure maps written by the compose `structure` pass. */
  pieceId: GPUTexture;
  jointDistM: GPUTexture;
  /** User B/N mask over the full atlas UV (red channel), or undefined. */
  mask?: GPUTexture;
  /** r32uint target: pack2x16float(loss 0..1, target depth in metres). */
  loss: GPUTexture;
}

/** Rows per banded dispatch (colour composite, JFA flood steps): short GPU jobs keep clear of the Windows TDR at 8192. */
export const BAND_ROWS = 1024;

/** Called between pass groups: submits the current encoder and returns a fresh one. */
export type Flush = () => GPUCommandEncoder;

function dispatch(encoder: GPUCommandEncoder, pipeline: GPUComputePipeline, group: GPUBindGroup, w: number, h: number): void {
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, group);
  pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
  pass.end();
}

/**
 * Encodes the wear loss pass (where the material breaks) into `encoder`. Returns the resources it created, to be
 * destroyed once the encoder has been submitted.
 */
export function encodeWearLoss(device: GPUDevice, encoder: GPUCommandEncoder, input: WearLossInput): { destroy(): void } {
  // The binding needs a texture even when no mask is used.
  const ownMask = input.mask ? null : device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING });
  const pipeline = cached(device, 'wearLoss', () => device.createComputePipeline({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: withCommon(wearLossWgsl) }), entryPoint: 'main' },
  }));
  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: input.params } },
      { binding: 1, resource: { buffer: input.rects } },
      { binding: 2, resource: input.rectId.createView() },
      { binding: 3, resource: input.pieceId.createView() },
      { binding: 4, resource: input.jointDistM.createView() },
      { binding: 5, resource: { buffer: input.wear } },
      { binding: 6, resource: (input.mask ?? ownMask!).createView() },
      {
        binding: 7,
        resource: device.createSampler({
          addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', magFilter: 'linear', minFilter: 'linear',
        }),
      },
      { binding: 8, resource: input.loss.createView() },
    ],
  });
  dispatch(encoder, pipeline, group, input.loss.width, input.loss.height);
  return {
    destroy() {
      ownMask?.destroy();
    },
  };
}

/** bandM floor, injected into wearComposite.wgsl (override MIN_BAND_M), so a zero band stays a valid smoothstep range. */
export const MIN_BAND_M = 1e-5;

export interface BorderInput {
  /** r32uint pack2x16float(loss, depth); a pixel is lost when loss > 0.5, groove floor when loss < 0. */
  loss: GPUTexture;
  /** r32uint rect ids; contours only form between pixels of the same rect. */
  rectId: GPUTexture;
  /** r32float target, same size: signed metres to the loss contour, negative inside, clamped to ±4 · bandM. */
  border: GPUTexture;
  bandM: number;
  metresPerPx: number;
  /** Rows per flood dispatch (BAND_ROWS by default, rounded up to a multiple of 8). */
  bandRows?: number;
}

const JFA_SLOT = 256;

function roundBand(rows: number | undefined): number {
  return Math.max(8, Math.ceil((rows ?? BAND_ROWS) / 8) * 8);
}

function nextPow2(n: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(1, n)));
}

/**
 * Encodes the border pass: jump flooding from the loss contour. The border is clamped to ±4 · bandM, so the flood
 * starts at the step that covers that range instead of half the texture. The two seed textures are r32uint
 * (half-pixel x | y << 16), half the memory of rg32sint. Each flood step runs in row bands; with `flush` every step
 * goes in its own submit. Destroy the returned resources right after the last submit.
 */
export function encodeBorder(
  device: GPUDevice, encoder: GPUCommandEncoder, input: BorderInput, flush?: Flush,
): { destroy(): void } {
  const { width: w, height: h } = input.loss;
  // Seeds pack half-pixel coordinates (up to 2 · size) in 16 bits each.
  if (Math.max(w, h) > 32767) throw new Error(`encodeBorder: ${w}×${h} exceeds 32767 px`);
  const clampM = 4 * Math.max(input.bandM, MIN_BAND_M);
  const rangePx = Math.ceil(clampM / input.metresPerPx);
  const first = Math.min(nextPow2(rangePx + 1), Math.max(1, nextPow2(Math.max(w, h)) / 2));
  // first, first/2, …, 1, plus one more step of 1 (JFA+1) to fix the flood's rare misses.
  const steps: number[] = [];
  for (let s = first; s >= 1; s /= 2) steps.push(s);
  steps.push(1);

  const bandRows = roundBand(input.bandRows);
  const bands = Math.ceil(h / bandRows);
  // One slot per (step, band) with its row offset, then the resolve slot.
  const slots = steps.length * bands + 1;
  const uniforms = device.createBuffer({ size: slots * JFA_SLOT, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const data = new ArrayBuffer(slots * JFA_SLOT);
  const writeSlot = (i: number, step: number, rowOffset: number) => {
    new Int32Array(data, i * JFA_SLOT, 2).set([step, rowOffset]);
    new Float32Array(data, i * JFA_SLOT + 8, 2).set([input.metresPerPx, clampM]);
  };
  steps.forEach((step, i) => {
    for (let b = 0; b < bands; b++) writeSlot(i * bands + b, step, b * bandRows);
  });
  writeSlot(slots - 1, 0, 0);
  device.queue.writeBuffer(uniforms, 0, data);
  const slot = (i: number): GPUBindingResource => ({ buffer: uniforms, offset: i * JFA_SLOT, size: 16 });

  const seedUsage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
  const seeds = [0, 1].map(() => device.createTexture({ size: [w, h], format: 'r32uint', usage: seedUsage }));
  const module = cached(device, 'jfa.module', () => device.createShaderModule({ code: jfaWgsl }));
  const pipeline = (entryPoint: string) =>
    cached(device, `jfa.${entryPoint}`, () => device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } }));

  let enc = encoder;
  const seedPipeline = pipeline('seed');
  dispatch(enc, seedPipeline, device.createBindGroup({
    layout: seedPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 1, resource: input.loss.createView() },
      { binding: 3, resource: seeds[0].createView() },
      { binding: 5, resource: input.rectId.createView() },
    ],
  }), w, h);

  const floodPipeline = pipeline('flood');
  let cur = 0;
  steps.forEach((_, i) => {
    if (flush) enc = flush();
    for (let b = 0; b < bands; b++) {
      dispatch(enc, floodPipeline, device.createBindGroup({
        layout: floodPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: slot(i * bands + b) },
          { binding: 2, resource: seeds[cur].createView() },
          { binding: 3, resource: seeds[1 - cur].createView() },
        ],
      }), w, Math.min(bandRows, h - b * bandRows));
    }
    cur = 1 - cur;
  });
  if (flush) enc = flush();

  const resolvePipeline = pipeline('resolve');
  dispatch(enc, resolvePipeline, device.createBindGroup({
    layout: resolvePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: slot(slots - 1) },
      { binding: 1, resource: input.loss.createView() },
      { binding: 2, resource: seeds[cur].createView() },
      { binding: 4, resource: input.border.createView() },
    ],
  }), w, h);

  return {
    destroy() {
      for (const t of seeds) t.destroy();
      uniforms.destroy();
    },
  };
}

export interface WearCompositeInput {
  params: GPUBuffer;
  rects: GPUBuffer;
  wear: GPUBuffer;
  rectId: GPUTexture;
  loss: GPUTexture;
  border: GPUTexture;
  /** r32float, updated in place: material height in, final height out. */
  height: GPUTexture;
  /** r32float, updated in place: groove / bevel height in, final macro height out. */
  macroHeight: GPUTexture;
  /** rgba8unorm target. */
  wearMask: GPUTexture;
}

/** Encodes the wear height composite: final height, final macro height and wearMask (wearComposite.wgsl). */
export function encodeWearComposite(device: GPUDevice, encoder: GPUCommandEncoder, input: WearCompositeInput): void {
  const pipeline = cached(device, 'wearComposite', () => device.createComputePipeline({
    layout: 'auto',
    compute: {
      module: device.createShaderModule({ code: withCommon(wearCompositeWgsl) }),
      entryPoint: 'main',
      constants: { MIN_BAND_M },
    },
  }));
  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: input.params } },
      { binding: 1, resource: { buffer: input.rects } },
      { binding: 2, resource: input.rectId.createView() },
      { binding: 3, resource: { buffer: input.wear } },
      { binding: 4, resource: input.loss.createView() },
      { binding: 5, resource: input.border.createView() },
      { binding: 6, resource: input.height.createView() },
      { binding: 7, resource: input.macroHeight.createView() },
      { binding: 8, resource: input.wearMask.createView() },
    ],
  });
  dispatch(encoder, pipeline, group, input.height.width, input.height.height);
}

/** Material maps the colour composite samples: the top material, or the second set (substrate). */
export interface ColorMaps {
  baseColor: GPUTexture;
  roughness: GPUTexture;
  metallic: GPUTexture;
  ao: GPUTexture;
}

export interface ColorCompositeInput {
  params: GPUBuffer;
  rects: GPUBuffer;
  wear: GPUBuffer;
  rectId: GPUTexture;
  /** Final height and final macro height (r32float). */
  height: GPUTexture;
  macroHeight: GPUTexture;
  /** The material ships a real AO map: height AO runs on the macro height only (R33). */
  aoOnMacro: boolean;
  /** 1 × 1 placeholders without wear, never read then. */
  loss: GPUTexture;
  border: GPUTexture;
  wearMask: GPUTexture;
  material: ColorMaps;
  /** The second set; without it the material's own maps are bound (and unused: substrateSource is 0). */
  substrate?: ColorMaps;
  /** Metres below a loss its runoff reaches (WearUniforms.lossRunoffM); 0 skips the walk above each chunk. */
  lossRunoffM: number;
  metresPerPx: number;
  /** rgba8unorm targets. */
  out: ColorMaps;
  /** Rows per dispatch (BAND_ROWS by default), rounded down to whole chunks. */
  bandRows?: number;
}

const BAND_SLOT = 256;

/**
 * Encodes the colour composite (colorComposite.wgsl): final baseColor, roughness, metallic and AO. Each invocation
 * walks a chunk of one column top to bottom, so it knows the latest loss above it; chunks are half the runoff reach
 * (32 to 128 rows) and first walk that reach above themselves, reading only rect id and loss, so a tall atlas still
 * splits into many invocations. The heaviest pass: it runs in bands of whole chunks (about BAND_ROWS rows), each in its
 * own submit when `flush` is given. Destroy the returned resources after the last submit.
 */
export function encodeColorComposite(
  device: GPUDevice, encoder: GPUCommandEncoder, input: ColorCompositeInput, flush?: Flush,
): { destroy(): void } {
  const { width: w, height: h } = input.height;
  const lookback = input.lossRunoffM > 0 ? Math.ceil(input.lossRunoffM / input.metresPerPx) : 0;
  // Half the reach, kept to 32..128 rows: short chunks re-walk too much, long ones leave the GPU idle (R33).
  const chunk = lookback > 0 ? Math.min(128, Math.max(32, Math.ceil(lookback / 2))) : 8;
  const ao = input.aoOnMacro ? 1 : 0;
  // Chunk and lookback are uniforms (bandOffset.yz), so the key names only the overrides.
  const pipeline = cached(device, `colorComposite:${ao}`, () => device.createComputePipeline({
    layout: 'auto',
    compute: {
      module: cached(device, 'colorComposite.module', () =>
        device.createShaderModule({ code: withCommon(colorCompositeWgsl) })),
      entryPoint: 'main',
      constants: { MIN_BAND_M, AO_ON_MACRO: ao },
    },
  }));
  const chunks = Math.ceil(h / chunk);
  const perBand = Math.max(1, Math.floor((input.bandRows ?? BAND_ROWS) / chunk));
  const bands = Math.ceil(chunks / perBand);
  // One uniform slot per band: its first chunk, the chunk rows and the lookback rows (bandOffset.xyz).
  const offsets = device.createBuffer({ size: bands * BAND_SLOT, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const offsetData = new Uint32Array((bands * BAND_SLOT) / 4);
  for (let b = 0; b < bands; b++) offsetData.set([b * perBand, chunk, lookback], (b * BAND_SLOT) / 4);
  device.queue.writeBuffer(offsets, 0, offsetData);
  const sub = input.substrate ?? input.material;
  const maps = (base: number, m: ColorMaps) => [m.baseColor, m.roughness, m.metallic, m.ao].map((t, i) => ({
    binding: base + i, resource: t.createView(),
  }));
  const sampler = device.createSampler({
    addressModeU: 'repeat', addressModeV: 'repeat', magFilter: 'linear', minFilter: 'linear',
  });
  const group = (b: number) => device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: input.params } },
      { binding: 1, resource: { buffer: input.rects } },
      { binding: 2, resource: input.rectId.createView() },
      { binding: 3, resource: sampler },
      { binding: 4, resource: { buffer: input.wear } },
      { binding: 5, resource: input.height.createView() },
      { binding: 6, resource: input.loss.createView() },
      { binding: 7, resource: input.border.createView() },
      { binding: 8, resource: input.wearMask.createView() },
      ...maps(9, input.material),
      ...maps(13, sub),
      ...maps(17, input.out),
      { binding: 21, resource: input.macroHeight.createView() },
      { binding: 22, resource: { buffer: offsets, offset: b * BAND_SLOT, size: 16 } },
    ],
  });
  let enc = encoder;
  for (let b = 0; b < bands; b++) {
    if (flush && b > 0) enc = flush();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group(b));
    pass.dispatchWorkgroups(Math.ceil(w / 64), Math.min(perBand, chunks - b * perBand));
    pass.end();
  }
  return {
    destroy() {
      offsets.destroy();
    },
  };
}

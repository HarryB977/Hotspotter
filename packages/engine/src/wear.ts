import { DEFAULT_DIRT, WEAR_FAMILIES } from '@hotspotter/core';
import type { WearParams } from '@hotspotter/core';
import { WEAR_BYTES, WEAR_F_BANDM, packWear, withCommon } from './params';
import type { WearExtra } from './params';
import wearLossWgsl from './shaders/wearLoss.wgsl?raw';
import jfaWgsl from './shaders/jfa.wgsl?raw';
import wearCompositeWgsl from './shaders/wearComposite.wgsl?raw';

export interface WearUniforms {
  buffer: GPUBuffer;
  /** Sanitised bandM as packed (0 without wear). */
  bandM: number;
}

/** The Wear uniform buffer (R17). Without wear it is all zeros, so `W.enabled` is 0 for every consumer. */
export function createWearUniforms(device: GPUDevice, wear: WearParams | undefined, extra: WearExtra): WearUniforms {
  const data = wear
    ? packWear(wear, DEFAULT_DIRT, WEAR_FAMILIES[wear.family] ?? WEAR_FAMILIES.brittle, extra)
    : new ArrayBuffer(WEAR_BYTES);
  const buffer = device.createBuffer({ size: WEAR_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buffer, 0, data);
  return { buffer, bandM: new Float32Array(data)[WEAR_F_BANDM] };
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
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: withCommon(wearLossWgsl) }), entryPoint: 'main' },
  });
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
}

const JFA_SLOT = 256;

function nextPow2(n: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(1, n)));
}

/**
 * Encodes the border pass: jump flooding from the loss contour. The border is clamped to ±4 · bandM, so the flood
 * starts at the step that covers that range instead of half the texture. The two seed textures are r32uint
 * (half-pixel x | y << 16), half the memory of rg32sint. Destroy the returned resources right after submitting.
 */
export function encodeBorder(device: GPUDevice, encoder: GPUCommandEncoder, input: BorderInput): { destroy(): void } {
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

  const slots = steps.length + 1;
  const uniforms = device.createBuffer({ size: slots * JFA_SLOT, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const data = new ArrayBuffer(slots * JFA_SLOT);
  [...steps, 0].forEach((step, i) => {
    new Int32Array(data, i * JFA_SLOT, 2).set([step, 0]);
    new Float32Array(data, i * JFA_SLOT + 8, 2).set([input.metresPerPx, clampM]);
  });
  device.queue.writeBuffer(uniforms, 0, data);
  const slot = (i: number): GPUBindingResource => ({ buffer: uniforms, offset: i * JFA_SLOT, size: 16 });

  const seedUsage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
  const seeds = [0, 1].map(() => device.createTexture({ size: [w, h], format: 'r32uint', usage: seedUsage }));
  const module = device.createShaderModule({ code: jfaWgsl });
  const pipeline = (entryPoint: string) => device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } });

  const seedPipeline = pipeline('seed');
  dispatch(encoder, seedPipeline, device.createBindGroup({
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
    dispatch(encoder, floodPipeline, device.createBindGroup({
      layout: floodPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: slot(i) },
        { binding: 2, resource: seeds[cur].createView() },
        { binding: 3, resource: seeds[1 - cur].createView() },
      ],
    }), w, h);
    cur = 1 - cur;
  });

  const resolvePipeline = pipeline('resolve');
  dispatch(encoder, resolvePipeline, device.createBindGroup({
    layout: resolvePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: slot(steps.length) },
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
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: {
      module: device.createShaderModule({ code: withCommon(wearCompositeWgsl) }),
      entryPoint: 'main',
      constants: { MIN_BAND_M },
    },
  });
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

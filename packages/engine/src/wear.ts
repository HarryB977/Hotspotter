import { DEFAULT_DIRT, WEAR_FAMILIES } from '@hotspotter/core';
import type { WearParams } from '@hotspotter/core';
import { WEAR_BYTES, packWear, withCommon } from './params';
import wearLossWgsl from './shaders/wearLoss.wgsl?raw';

export interface WearLossInput {
  wear: WearParams;
  params: GPUBuffer;
  rects: GPUBuffer;
  rectId: GPUTexture;
  /** Atlas-space structure maps written by the compose `structure` pass. */
  pieceId: GPUTexture;
  jointDistM: GPUTexture;
  hasPieces: boolean;
  grainAxis: 'x' | 'y' | null;
  /** User B/N mask over the full atlas UV (red channel), or undefined. */
  mask?: GPUTexture;
  /** rg32float target: R = loss 0..1, G = target depth in metres. */
  loss: GPUTexture;
}

/**
 * Encodes the wear loss pass (where the material breaks) into `encoder`. Returns the resources it created, to be
 * destroyed once the encoder has been submitted.
 */
export function encodeWearLoss(device: GPUDevice, encoder: GPUCommandEncoder, input: WearLossInput): { destroy(): void } {
  const { wear } = input;
  const shape = WEAR_FAMILIES[wear.family] ?? WEAR_FAMILIES.brittle;
  const wearBuf = device.createBuffer({ size: WEAR_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(
    wearBuf, 0,
    packWear(wear, DEFAULT_DIRT, shape, { hasPieces: input.hasPieces, grainAxis: input.grainAxis, maskBound: !!input.mask }),
  );
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
      { binding: 5, resource: { buffer: wearBuf } },
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
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, group);
  pass.dispatchWorkgroups(Math.ceil(input.loss.width / 8), Math.ceil(input.loss.height / 8));
  pass.end();
  return {
    destroy() {
      wearBuf.destroy();
      ownMask?.destroy();
    },
  };
}

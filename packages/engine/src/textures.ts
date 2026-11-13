import type { GpuContext } from './gpu';

const USAGE =
  GPUTextureUsage.TEXTURE_BINDING |
  GPUTextureUsage.COPY_DST |
  GPUTextureUsage.COPY_SRC |
  GPUTextureUsage.RENDER_ATTACHMENT;

export function uploadRgba8(ctx: GpuContext, bmp: ImageBitmap, opts: { srgb: boolean }): GPUTexture {
  const texture = ctx.device.createTexture({
    size: [bmp.width, bmp.height],
    format: opts.srgb ? 'rgba8unorm-srgb' : 'rgba8unorm',
    usage: USAGE,
  });
  ctx.device.queue.copyExternalImageToTexture({ source: bmp }, { texture }, [bmp.width, bmp.height]);
  return texture;
}

export function createConstTexture(ctx: GpuContext, rgba: [number, number, number, number]): GPUTexture {
  const texture = ctx.device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: USAGE });
  ctx.device.queue.writeTexture({ texture }, new Uint8Array(rgba), { bytesPerRow: 4 }, [1, 1]);
  return texture;
}

/**
 * Copies a 4-byte-per-texel texture into a mappable buffer and returns the unpadded bytes. The copy is submitted
 * before the first await, so the caller may destroy `tex` as soon as this returns its promise.
 */
async function readback4(ctx: GpuContext, tex: GPUTexture): Promise<Uint8Array> {
  const { device } = ctx;
  const { width, height } = tex;
  const rowBytes = width * 4;
  const bytesPerRow = Math.ceil(rowBytes / 256) * 256;
  const buffer = device.createBuffer({
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture: tex }, { buffer, bytesPerRow }, [width, height]);
  device.queue.submit([encoder.finish()]);
  try {
    await buffer.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(buffer.getMappedRange());
    const data = new Uint8Array(rowBytes * height);
    for (let y = 0; y < height; y++) {
      data.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + rowBytes), y * rowBytes);
    }
    buffer.unmap();
    return data;
  } finally {
    buffer.destroy();
  }
}

export async function readbackRgba8(
  ctx: GpuContext,
  tex: GPUTexture,
): Promise<{ width: number; height: number; data: Uint8Array }> {
  return { width: tex.width, height: tex.height, data: await readback4(ctx, tex) };
}

/**
 * Reads back a single-channel 32-bit texture (R19): r32float as Float32Array, r32uint as Uint32Array, row-major.
 * Like readbackRgba8, the copy is submitted before the first await.
 */
export function readbackR32(
  ctx: GpuContext,
  tex: GPUTexture,
): Promise<{ width: number; height: number; data: Float32Array | Uint32Array }> {
  const { width, height, format } = tex;
  if (format !== 'r32float' && format !== 'r32uint') {
    return Promise.reject(new Error(`readbackR32: unsupported format ${format}`));
  }
  return readback4(ctx, tex).then((b) => {
    const n = width * height;
    const data = format === 'r32float'
      ? new Float32Array(b.buffer, b.byteOffset, n)
      : new Uint32Array(b.buffer, b.byteOffset, n);
    return { width, height, data };
  });
}

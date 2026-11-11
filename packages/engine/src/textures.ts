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

export async function readbackRgba8(
  ctx: GpuContext,
  tex: GPUTexture,
): Promise<{ width: number; height: number; data: Uint8Array }> {
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
  await buffer.mapAsync(GPUMapMode.READ);
  const padded = new Uint8Array(buffer.getMappedRange());
  const data = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    data.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + rowBytes), y * rowBytes);
  }
  buffer.unmap();
  buffer.destroy();
  return { width, height, data };
}

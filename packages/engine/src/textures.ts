import type { GpuContext } from './gpu';
import { cached } from './pipelines';

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
 * Copies a `texelBytes`-per-texel texture into a mappable buffer and returns the unpadded bytes. The copy is submitted
 * before the first await, so the caller may destroy `tex` as soon as this returns its promise.
 */
async function readback4(ctx: GpuContext, tex: GPUTexture, texelBytes = 4): Promise<Uint8Array> {
  const { device } = ctx;
  const { width, height } = tex;
  const rowBytes = width * texelBytes;
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

const DETAIL_SLOPE_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> out: array<f32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let size = textureDimensions(src);
  if (gid.x >= size.x || gid.y >= size.y) { return; }
  let n = textureLoad(src, vec2<i32>(gid.xy), 0).xyz;
  out[gid.y * size.x + gid.x] = length(n.xy) / max(n.z, 1e-3);
}
`;

/**
 * Reads back the slope |n.xy| / max(n.z, 1e-3) of an rgba16float normal (unnormalised xyz), one f32 per pixel,
 * row-major: 4 bytes per pixel of staging instead of 8 for the RGBA, and no RGBA copy on the CPU. Like readbackRgba8,
 * the work is submitted before the first await.
 */
export function readbackDetailSlope(
  ctx: GpuContext,
  tex: GPUTexture,
): Promise<{ width: number; height: number; data: Float32Array }> {
  const { device } = ctx;
  const { width, height, format } = tex;
  if (format !== 'rgba16float') return Promise.reject(new Error(`readbackDetailSlope: unsupported format ${format}`));
  const pipeline = cached(device, 'detailSlope', () => device.createComputePipeline({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: DETAIL_SLOPE_WGSL }), entryPoint: 'main' },
  }));
  const bytes = width * height * 4;
  const storage = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const staging = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: tex.createView() }, { binding: 1, resource: { buffer: storage } }],
  }));
  pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
  pass.end();
  encoder.copyBufferToBuffer(storage, 0, staging, 0, bytes);
  device.queue.submit([encoder.finish()]);
  storage.destroy();
  return (async () => {
    try {
      await staging.mapAsync(GPUMapMode.READ);
      const data = new Float32Array(staging.getMappedRange().slice(0));
      staging.unmap();
      return { width, height, data };
    } finally {
      staging.destroy();
    }
  })();
}

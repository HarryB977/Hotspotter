import { MAP_DEFAULTS } from '@hotspotter/core';
import type { MapKind, MaterialSettings } from '@hotspotter/core';
import type { GpuContext } from './gpu';
import { createConstTexture, uploadRgba8 } from './textures';
import flipGreenWgsl from './shaders/flipGreen.wgsl?raw';

export interface LoadedMaterial {
  settings: MaterialSettings;
  images: Partial<Record<MapKind, ImageBitmap>>;
}

/** Every map is present; missing ones are 1x1 constants from MAP_DEFAULTS. Normal is GL. */
export interface GpuMaterial {
  textures: Record<MapKind, GPUTexture>;
  settings: MaterialSettings;
}

const KINDS: MapKind[] = ['baseColor', 'normal', 'height', 'roughness', 'metallic', 'ao', 'opacity'];

const toByte = (v: number): number => Math.round(v * 255);

function defaultRgba(kind: MapKind): [number, number, number, number] {
  // baseColor has no default in core; a missing albedo is mid grey.
  const v = kind === 'baseColor' ? 0.5 : MAP_DEFAULTS[kind];
  const [r, g, b] = typeof v === 'number' ? [v, v, v] : v;
  return [toByte(r), toByte(g), toByte(b), 255];
}

function flipGreen(ctx: GpuContext, src: GPUTexture): GPUTexture {
  const { device } = ctx;
  const dst = device.createTexture({
    size: [src.width, src.height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
  });
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: flipGreenWgsl }), entryPoint: 'main' },
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: src.createView() },
      { binding: 1, resource: dst.createView() },
    ],
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(src.width / 8), Math.ceil(src.height / 8));
  pass.end();
  device.queue.submit([encoder.finish()]);
  src.destroy();
  return dst;
}

/** Uploads every map as raw rgba8unorm bytes (no sRGB decode). DX normals are converted to GL. */
export function uploadMaterial(ctx: GpuContext, m: LoadedMaterial): GpuMaterial {
  const textures = {} as Record<MapKind, GPUTexture>;
  for (const kind of KINDS) {
    const bmp = m.images[kind];
    if (!bmp) {
      textures[kind] = createConstTexture(ctx, defaultRgba(kind));
      continue;
    }
    const tex = uploadRgba8(ctx, bmp, { srgb: false });
    textures[kind] = kind === 'normal' && m.settings.normalConvention === 'dx' ? flipGreen(ctx, tex) : tex;
  }
  return { textures, settings: m.settings };
}

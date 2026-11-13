import * as core from '@hotspotter/core';
import * as engine from '@hotspotter/engine';
import type { AtlasMaps } from '@hotspotter/engine';
import { evalStats, materialJointMean, useProject } from '../state/store';

export interface SampleFile {
  name: string;
  bitmap: ImageBitmap;
}

export async function loadSample(dir: string): Promise<SampleFile[]> {
  const base = encodeURIComponent(dir).replace(/%2F/g, '/');
  const names: string[] = await (await fetch(`/samples-index/${base}`)).json();
  return Promise.all(
    names.map(async (name) => {
      const res = await fetch(`/samples/${base}/${encodeURIComponent(name)}`);
      const bitmap = await createImageBitmap(await res.blob(), {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
      });
      return { name, bitmap };
    }),
  );
}

export interface HsHarness {
  core: typeof core;
  engine: typeof engine;
  loadSample: typeof loadSample;
  store: typeof useProject;
  /**
   * Runs a tiny compute shader (withCommon prelude prepended). The body must declare
   * `@group(0) @binding(0) var out: texture_storage_2d<r32float, write>;` and an `@compute @workgroup_size(8, 8)`
   * `fn main`. Returns the w*h r32float texels, row-major.
   */
  runCompute: (wgslBody: string, w: number, h: number) => Promise<Float32Array>;
  /** Latest composed atlas maps, or null. */
  readonly lastAtlas: AtlasMaps | null;
  /** Evaluation debug counters: composes of its own, evaluations running now and at most at once. */
  evalStats: typeof evalStats;
  /** The store's material-space joint colour (R37) of the current material and structure, or null. */
  jointMean(): [number, number, number] | null;
}

declare global {
  interface Window {
    __hs?: HsHarness;
  }
}

let computeGpu: Promise<engine.GpuContext> | null = null;

export async function runCompute(wgslBody: string, w: number, h: number): Promise<Float32Array> {
  const { device } = await (computeGpu ??= engine.initGpu());
  const tex = device.createTexture({
    size: [w, h],
    format: 'r32float',
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
  });
  const bytesPerRow = Math.ceil((w * 4) / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const module = device.createShaderModule({ code: engine.withCommon(wgslBody) });
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: tex.createView() }],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass.end();
    encoder.copyTextureToBuffer({ texture: tex }, { buffer, bytesPerRow }, [w, h]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const padded = new Float32Array(buffer.getMappedRange());
    const out = new Float32Array(w * h);
    const rowFloats = bytesPerRow / 4;
    for (let y = 0; y < h; y++) out.set(padded.subarray(y * rowFloats, y * rowFloats + w), y * w);
    buffer.unmap();
    return out;
  } finally {
    tex.destroy();
    buffer.destroy();
  }
}

export function installHarness(): void {
  window.__hs = {
    core,
    engine,
    loadSample,
    runCompute,
    store: useProject,
    evalStats,
    jointMean() {
      const { gpuMaterial, structure, material } = useProject.getState();
      return gpuMaterial && structure ? materialJointMean(gpuMaterial, structure, material?.images.baseColor) : null;
    },
    get lastAtlas() {
      return useProject.getState().atlas?.maps ?? null;
    },
  };
}

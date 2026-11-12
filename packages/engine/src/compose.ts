import { pxPerMetre } from '@hotspotter/core';
import type { GrooveProfile, HotspotLayout, RectPlacement } from '@hotspotter/core';
import type { GpuContext } from './gpu';
import type { GpuMaterial } from './material';
import rectIdWgsl from './shaders/rectId.wgsl?raw';
import composeWgsl from './shaders/compose.wgsl?raw';
import normalFromHeightWgsl from './shaders/normalFromHeight.wgsl?raw';
import heightRangeWgsl from './shaders/heightRange.wgsl?raw';
import heightToRgba8Wgsl from './shaders/heightToRgba8.wgsl?raw';

export interface ComposeInput {
  layout: HotspotLayout;
  material: GpuMaterial;
  placements: RectPlacement[];
  resolutionPx: number;
}

export interface AtlasMaps {
  baseColor: GPUTexture;
  normal: GPUTexture;
  /** r32float, metres */
  height: GPUTexture;
  roughness: GPUTexture;
  metallic: GPUTexture;
  ao: GPUTexture;
  /** r32uint: rect index + 1, 0 = groove / empty */
  rectId: GPUTexture;
  heightRangeM: [number, number];
}

const MAX_RECTS = 256;

const PROFILE_CODE: Record<GrooveProfile, number> = { bevel: 0, round: 1, step: 2, none: 3 };
const PARAMS_BYTES = 64;
const RECT_BYTES = 32;

const OUT_USAGE =
  GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;

function workgroups(n: number): number {
  return Math.ceil(n / 8);
}

function paramsBuffer(device: GPUDevice, input: ComposeInput, outW: number, outH: number): GPUBuffer {
  const { layout, material } = input;
  const s = material.settings;
  const data = new ArrayBuffer(PARAMS_BYTES);
  const f = new Float32Array(data);
  const u = new Uint32Array(data);
  f[0] = outW;
  f[1] = outH;
  f[2] = input.resolutionPx / layout.widthPx;
  f[3] = pxPerMetre(layout);
  f[4] = s.tileSizeM[0];
  f[5] = s.tileSizeM[1];
  f[6] = s.heightScaleM;
  f[7] = layout.groove.widthM;
  f[8] = layout.groove.depthM;
  u[9] = PROFILE_CODE[layout.groove.profile];
  u[10] = s.roughnessIsGloss ? 1 : 0;
  f[11] = layout.heightPx;
  u[12] = material.hasNormalMap ? 1 : 0;
  const buf = device.createBuffer({ size: PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buf, 0, data);
  return buf;
}

function rectsBuffer(device: GPUDevice, layout: HotspotLayout, placements: RectPlacement[]): GPUBuffer {
  const byId = new Map(placements.map((p) => [p.rectId, p]));
  // Storage buffers cannot be empty.
  const data = new ArrayBuffer(Math.max(1, layout.rects.length) * RECT_BYTES);
  const f = new Float32Array(data);
  const u = new Uint32Array(data);
  layout.rects.forEach((r, i) => {
    const pl = byId.get(r.id);
    if (!pl) throw new Error(`composeAtlas: no placement for rect "${r.id}"`);
    const o = (i * RECT_BYTES) / 4;
    f.set([r.x, r.y, r.w, r.h, pl.originM[0], pl.originM[1]], o);
    u[o + 6] = pl.rotate90 ? 1 : 0;
  });
  const buf = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buf, 0, data);
  return buf;
}

function renderRectIds(
  device: GPUDevice, encoder: GPUCommandEncoder, target: GPUTexture,
  params: GPUBuffer, rects: GPUBuffer, count: number,
): void {
  const module = device.createShaderModule({ code: rectIdWgsl });
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'r32uint' }] },
    primitive: { topology: 'triangle-list' },
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: params } },
      { binding: 1, resource: { buffer: rects } },
    ],
  });
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0],
    }],
  });
  if (count > 0) {
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6, count);
  }
  pass.end();
}

function storageEntry(binding: number, format: GPUTextureFormat): GPUBindGroupLayoutEntry {
  return { binding, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format } };
}

async function reduceHeightRange(ctx: GpuContext, height: GPUTexture): Promise<[number, number]> {
  const { device } = ctx;
  const range = device.createBuffer({
    size: 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, mappedAtCreation: true,
  });
  new Uint32Array(range.getMappedRange()).set([0xffffffff, 0]);
  range.unmap();
  const read = device.createBuffer({ size: 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: heightRangeWgsl }), entryPoint: 'main' },
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: height.createView() },
      { binding: 1, resource: { buffer: range } },
    ],
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(workgroups(height.width), workgroups(height.height));
  pass.end();
  encoder.copyBufferToBuffer(range, 0, read, 0, 8);
  device.queue.submit([encoder.finish()]);
  await read.mapAsync(GPUMapMode.READ);
  const keys = new Uint32Array(read.getMappedRange().slice(0));
  read.unmap();
  read.destroy();
  range.destroy();
  // Inverse of orderedKey in heightRange.wgsl.
  const bits = new Uint32Array(2);
  for (let i = 0; i < 2; i++) bits[i] = keys[i] & 0x80000000 ? keys[i] ^ 0x80000000 : ~keys[i];
  const f = new Float32Array(bits.buffer);
  return [f[0], f[1]];
}

export async function composeAtlas(ctx: GpuContext, input: ComposeInput): Promise<AtlasMaps> {
  const { device } = ctx;
  const { layout, material, placements, resolutionPx } = input;
  if (layout.rects.length > MAX_RECTS) {
    throw new Error(`composeAtlas: ${layout.rects.length} rects exceeds the maximum of ${MAX_RECTS}`);
  }
  const outW = resolutionPx;
  const outH = Math.round((layout.heightPx * resolutionPx) / layout.widthPx);
  const tex = (format: GPUTextureFormat, usage = OUT_USAGE) =>
    device.createTexture({ size: [outW, outH], format, usage });

  const rectId = tex('r32uint', GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC);
  const baseColor = tex('rgba8unorm');
  const matNormal = tex('rgba16float', GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING);
  const height = tex('r32float');
  const roughness = tex('rgba8unorm');
  const metallic = tex('rgba8unorm');
  const ao = tex('rgba8unorm');
  const normal = tex('rgba8unorm');

  const params = paramsBuffer(device, input, outW, outH);
  const rects = rectsBuffer(device, layout, placements);
  const encoder = device.createCommandEncoder();

  // Pass 1: rect ids.
  renderRectIds(device, encoder, rectId, params, rects, layout.rects.length);

  // Pass 2: material sampling and groove profile.
  const tx = { sampleType: 'float' as const };
  const inputLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'uint' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
      ...[4, 5, 6, 7, 8, 9].map((binding) => ({ binding, visibility: GPUShaderStage.COMPUTE, texture: tx })),
    ],
  });
  const t = material.textures;
  const inputs = device.createBindGroup({
    layout: inputLayout,
    entries: [
      { binding: 0, resource: { buffer: params } },
      { binding: 1, resource: { buffer: rects } },
      { binding: 2, resource: rectId.createView() },
      {
        binding: 3,
        resource: device.createSampler({
          addressModeU: 'repeat', addressModeV: 'repeat', magFilter: 'linear', minFilter: 'linear',
        }),
      },
      ...[t.baseColor, t.normal, t.height, t.roughness, t.metallic, t.ao].map((m, i) => ({
        binding: 4 + i, resource: m.createView(),
      })),
    ],
  });
  const composeModule = device.createShaderModule({ code: composeWgsl });
  const surfaceLayout = device.createBindGroupLayout({
    entries: [storageEntry(0, 'rgba8unorm'), storageEntry(1, 'rgba16float'), storageEntry(2, 'r32float')],
  });
  const scalarLayout = device.createBindGroupLayout({
    entries: [storageEntry(3, 'rgba8unorm'), storageEntry(4, 'rgba8unorm'), storageEntry(5, 'rgba8unorm')],
  });
  const composePass = (entryPoint: string, outLayout: GPUBindGroupLayout, outs: [number, GPUTexture][]) => {
    const pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [inputLayout, outLayout] }),
      compute: { module: composeModule, entryPoint },
    });
    const outGroup = device.createBindGroup({
      layout: outLayout,
      entries: outs.map(([binding, target]) => ({ binding, resource: target.createView() })),
    });
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, inputs);
    pass.setBindGroup(1, outGroup);
    pass.dispatchWorkgroups(workgroups(outW), workgroups(outH));
    pass.end();
  };
  composePass('surface', surfaceLayout, [[0, baseColor], [1, matNormal], [2, height]]);
  composePass('scalars', scalarLayout, [[3, roughness], [4, metallic], [5, ao]]);

  // Pass 3: normal from height combined with the material normal.
  const normalPipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: normalFromHeightWgsl }), entryPoint: 'main' },
  });
  const normalGroup = device.createBindGroup({
    layout: normalPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: params } },
      { binding: 1, resource: height.createView() },
      { binding: 2, resource: matNormal.createView() },
      { binding: 3, resource: normal.createView() },
    ],
  });
  const normalPass = encoder.beginComputePass();
  normalPass.setPipeline(normalPipeline);
  normalPass.setBindGroup(0, normalGroup);
  normalPass.dispatchWorkgroups(workgroups(outW), workgroups(outH));
  normalPass.end();

  device.queue.submit([encoder.finish()]);
  const heightRangeM = await reduceHeightRange(ctx, height);
  params.destroy();
  rects.destroy();
  matNormal.destroy();

  return { baseColor, normal, height, roughness, metallic, ao, rectId, heightRangeM };
}

/** Height normalized by heightRangeM into rgba8unorm (grey, A = 255), for export and preview. */
export function heightToRgba8(ctx: GpuContext, maps: AtlasMaps): GPUTexture {
  const { device } = ctx;
  const { height } = maps;
  const out = device.createTexture({ size: [height.width, height.height], format: 'rgba8unorm', usage: OUT_USAGE });
  const range = device.createBuffer({ size: 8, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(range, 0, new Float32Array(maps.heightRangeM));
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: heightToRgba8Wgsl }), entryPoint: 'main' },
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: height.createView() },
      { binding: 1, resource: { buffer: range } },
      { binding: 2, resource: out.createView() },
    ],
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(workgroups(height.width), workgroups(height.height));
  pass.end();
  device.queue.submit([encoder.finish()]);
  range.destroy();
  return out;
}

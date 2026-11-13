import { pxPerMetre } from '@hotspotter/core';
import type { DirtParams, HotspotLayout, RectPlacement, WearParams } from '@hotspotter/core';
import type { GpuContext } from './gpu';
import type { GpuMaterial } from './material';
import { continuousStructure } from './structure';
import type { GpuStructure } from './structure';
import { PARAMS_BYTES, packParams, withCommon } from './params';
import { createWearUniforms, encodeBorder, encodeColorComposite, encodeWearComposite, encodeWearLoss } from './wear';
import { cached, cachedEntry, pipelinesReady, trackPipelines } from './pipelines';
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
  /** Material structure; without it the material is one continuous piece. */
  structure?: GpuStructure;
  /** Edge wear; without it `loss` is 0 everywhere. */
  wear?: WearParams;
  /** User B/N mask over the full atlas UV (white = more damage); applies when `wear.mask.enabled`. */
  mask?: GPUTexture;
  /** Material grain axis (structure analysis); voronoi cells stretch along it. */
  grainAxis?: 'x' | 'y' | null;
  /** Cavity dirt and runoff; they apply with and without wear. Without it there is no dirt. */
  dirt?: DirtParams;
  /**
   * Second PBR set revealed in the loss when `wear.substrate.source` is 'secondSet' (uploadMaterial, like the top
   * material). Sampled at the same material metres as the top material, with its own tileSizeM, never stretched.
   */
  substrateMaterial?: GpuMaterial;
  /**
   * Rows per dispatch of the banded passes (colour composite, JFA flood); default BAND_ROWS (1024). The output does
   * not depend on it; tests use it to prove that.
   */
  bandRows?: number;
  /**
   * Keep the material detail normal (matNormal) as AtlasMaps.matNormal instead of freeing it, for the normal check
   * (R41). The preview and the evaluation keep it; the export does not. Changes no output.
   */
  keepMatNormal?: boolean;
}

export interface AtlasMaps {
  baseColor: GPUTexture;
  normal: GPUTexture;
  /** r32float, metres: the final height (material, groove and wear). */
  height: GPUTexture;
  /**
   * r32float, metres: everything but the intact material relief (groove, bevel and wear), the field the normal pass
   * runs Sobel on when the material has a normal map (R15, R19).
   */
  macroHeight: GPUTexture;
  roughness: GPUTexture;
  metallic: GPUTexture;
  ao: GPUTexture;
  /** r32uint: rect index + 1, 0 = groove / empty */
  rectId: GPUTexture;
  /** r32uint: material piece id at each pixel, 0 on joints and in the groove */
  pieceId: GPUTexture;
  /** r32float: metres to the nearest material joint, 0 in the groove */
  jointDistM: GPUTexture;
  /**
   * r32uint: pack2x16float(material lost 0..1, target depth in metres); 0 in the empty area (rect id 0). The groove
   * floor inside a rect (outside its visible edge) holds lossR = −1, a "never worn" marker (R31, R32a): every reader
   * must treat lossR < 0 as 0. Without wear it is a 1×1 placeholder (0): a 1×1 loss means no wear, and consumers
   * branch on Wear.enabled instead of reading it.
   */
  loss: GPUTexture;
  /**
   * r32float: signed metres to the loss contour, negative inside the loss, clamped to ±4 · bandM. 1×1 placeholder
   * without wear.
   */
  border: GPUTexture;
  /** rgba8unorm grey: the smoothed final loss (smoothstep(0, bandM, −border)), exportable. 1×1 placeholder without wear. */
  wearMask: GPUTexture;
  /**
   * rgba16float: the material detail normal in atlas space (xyz decoded, GL, rotation applied; the material default
   * (0.5, 0.5, 1) decoded, i.e. flat, without a normal map), alpha = f16 groove height. Only with keepMatNormal.
   */
  matNormal?: GPUTexture;
  heightRangeM: [number, number];
}

const MAX_RECTS = 256;

const RECT_BYTES = 32;

const OUT_USAGE =
  GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;

function workgroups(n: number): number {
  return Math.ceil(n / 8);
}

function paramsBuffer(device: GPUDevice, input: ComposeInput, outW: number, outH: number): GPUBuffer {
  const { layout, material } = input;
  const s = material.settings;
  const data = packParams({
    outW,
    outH,
    refScale: input.resolutionPx / layout.widthPx,
    ppmRef: pxPerMetre(layout),
    tileSizeM: s.tileSizeM,
    heightScaleM: s.heightScaleM,
    groove: layout.groove,
    roughnessIsGloss: s.roughnessIsGloss,
    refHeightPx: layout.heightPx,
    sobelMacro: material.hasNormalMap,
    seed: input.wear && Number.isFinite(input.wear.seed) ? input.wear.seed >>> 0 : 0,
  });
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
  const pipeline = cached(device, 'rectId', () => {
    const module = device.createShaderModule({ code: withCommon(rectIdWgsl) });
    return device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'r32uint' }] },
      primitive: { topology: 'triangle-list' },
    });
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

/** The compose surface / structure passes and their explicit bind group layouts, once per device. */
function composePipelines(device: GPUDevice) {
  return cached(device, 'compose', () => {
    const tx = { sampleType: 'float' as const };
    const inputLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'uint' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
        ...[5, 6].map((binding) => ({ binding, visibility: GPUShaderStage.COMPUTE, texture: tx })),
        { binding: 10, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'uint' } },
        { binding: 11, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      ],
    });
    const surfaceLayout = device.createBindGroupLayout({
      entries: [
        storageEntry(1, 'rgba16float'), storageEntry(2, 'r32float'), storageEntry(8, 'r32float'),
      ],
    });
    const structureLayout = device.createBindGroupLayout({
      entries: [storageEntry(6, 'r32uint'), storageEntry(7, 'r32float')],
    });
    const module = device.createShaderModule({ code: withCommon(composeWgsl) });
    const pipeline = (entryPoint: string, outLayout: GPUBindGroupLayout) => device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [inputLayout, outLayout] }),
      compute: { module, entryPoint },
    });
    return {
      inputLayout, surfaceLayout, structureLayout,
      surface: pipeline('surface', surfaceLayout), structure: pipeline('structure', structureLayout),
    };
  });
}

async function reduceHeightRange(ctx: GpuContext, height: GPUTexture): Promise<[number, number]> {
  const { device } = ctx;
  const range = device.createBuffer({
    size: 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, mappedAtCreation: true,
  });
  new Uint32Array(range.getMappedRange()).set([0xffffffff, 0]);
  range.unmap();
  const read = device.createBuffer({ size: 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const { value: pipeline, ready } = cachedEntry(device, 'heightRange', () => device.createComputePipeline({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: heightRangeWgsl }), entryPoint: 'main' },
  }));
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
  try {
    await pipelinesReady([ready]);
  } catch (e) {
    read.destroy();
    range.destroy();
    throw e;
  }
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
  // RENDER_ATTACHMENT: cleared by a render pass below. As a storage-only texture, Dawn's lazy clear would stage
  // 8 B/px (512 MiB at 8192²), over the default maxBufferSize (R39). COPY_SRC: the evaluation reads it back (R41).
  const matNormal = tex(
    'rgba16float',
    GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_SRC,
  );
  const height = tex('r32float');
  const macroHeight = tex('r32float');
  const roughness = tex('rgba8unorm');
  const metallic = tex('rgba8unorm');
  const ao = tex('rgba8unorm');
  const normal = tex('rgba8unorm');
  const pieceId = tex('r32uint');
  const jointDistM = tex('r32float');
  // Without wear these are 1×1 placeholders, never read (consumers branch on Wear.enabled).
  const placeholder = (format: GPUTextureFormat) => device.createTexture({ size: [1, 1], format, usage: OUT_USAGE });
  const loss = input.wear ? tex('r32uint') : placeholder('r32uint');
  const border = input.wear ? tex('r32float') : placeholder('r32float');
  const wearMask = input.wear ? tex('rgba8unorm') : placeholder('rgba8unorm');

  const params = paramsBuffer(device, input, outW, outH);
  const rects = rectsBuffer(device, layout, placements);
  const ownStructure = input.structure ? null : continuousStructure(ctx);
  const structure = input.structure ?? ownStructure!;
  const sub = input.substrateMaterial;
  const wearUniforms = createWearUniforms(device, input.wear, input.dirt, {
    hasPieces: structure.hasPieces, grainAxis: input.grainAxis ?? null, maskBound: !!input.mask,
    substrate: sub ? { tileSizeM: sub.settings.tileSizeM, roughnessIsGloss: sub.settings.roughnessIsGloss } : undefined,
    atlasHeightM: layout.heightPx / pxPerMetre(layout),
  });
  const metresPerPx = layout.widthPx / (pxPerMetre(layout) * resolutionPx);
  const wearResources: { destroy(): void }[] = [];
  const outputs = [
    rectId, baseColor, matNormal, height, macroHeight, roughness, metallic, ao, normal, pieceId, jointDistM, loss, border,
    wearMask,
  ];
  const bandRows = input.bandRows;
  // The pipelines this compose uses: their validation is awaited below, never another compose's (R39).
  const stopTracking = trackPipelines();
  let used: ReturnType<typeof stopTracking> = [];
  try {
    // Each pass group goes in its own submit, and the heaviest passes in row bands: no single GPU job runs long
    // enough at 8192 to trip the Windows TDR (device lost).
    let encoder = device.createCommandEncoder();
    const flush = () => {
      device.queue.submit([encoder.finish()]);
      encoder = device.createCommandEncoder();
      return encoder;
    };

    // Pass 1: rect ids, and the matNormal clear (no staging buffer, see above).
    renderRectIds(device, encoder, rectId, params, rects, layout.rects.length);
    encoder.beginRenderPass({
      colorAttachments: [{ view: matNormal.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
    }).end();

    // Pass 2: material surface (normal, height) and structure; colour and scalars come after the wear (pass 3).
    const { inputLayout, surfaceLayout, structureLayout, surface, structure: structurePipeline } = composePipelines(device);
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
        { binding: 5, resource: t.normal.createView() },
        { binding: 6, resource: t.height.createView() },
        { binding: 10, resource: structure.pieceId.createView() },
        { binding: 11, resource: structure.jointDistM.createView() },
      ],
    });
    const composePass = (pipeline: GPUComputePipeline, outLayout: GPUBindGroupLayout, outs: [number, GPUTexture][]) => {
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
    composePass(surface, surfaceLayout, [[1, matNormal], [2, height], [8, macroHeight]]);
    composePass(structurePipeline, structureLayout, [[6, pieceId], [7, jointDistM]]);
    flush();

    // Wear: loss, border distance and the height composite. Without wear every pass is skipped; `height` and
    // `macroHeight` stay as composed and loss, border and wearMask stay 1×1 placeholders.
    if (input.wear) {
      const wear = wearUniforms.buffer;
      wearResources.push(encodeWearLoss(device, encoder, {
        wear, params, rects, rectId, pieceId, jointDistM, loss, mask: input.mask,
      }));
      flush();
      wearResources.push(encodeBorder(
        device, encoder, { loss, rectId, border, bandM: wearUniforms.bandM, metresPerPx, bandRows }, flush,
      ));
      flush();
      encodeWearComposite(device, encoder, { params, rects, wear, rectId, loss, border, height, macroHeight, wearMask });
      flush();
    }

    // Pass 3: colour composite (substrate, edge tone, height AO, dirt) on the final height, with and without wear.
    wearResources.push(encodeColorComposite(device, encoder, {
      params, rects, wear: wearUniforms.buffer, rectId, height, macroHeight, aoOnMacro: material.hasMap.ao, loss, border, wearMask,
      material: t, substrate: sub?.textures, lossRunoffM: wearUniforms.lossRunoffM, metresPerPx,
      out: { baseColor, roughness, metallic, ao }, bandRows,
    }, flush));
    flush();

    // Pass 4: normal from height combined with the material normal.
    const normalPipeline = cached(device, 'normalFromHeight', () => device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: withCommon(normalFromHeightWgsl) }), entryPoint: 'main' },
    }));
    const normalGroup = device.createBindGroup({
      layout: normalPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: params } },
        { binding: 1, resource: height.createView() },
        { binding: 2, resource: matNormal.createView() },
        { binding: 3, resource: normal.createView() },
        { binding: 4, resource: macroHeight.createView() },
        { binding: 5, resource: { buffer: wearUniforms.buffer } },
        { binding: 6, resource: wearMask.createView() },
      ],
    });
    const normalPass = encoder.beginComputePass();
    normalPass.setPipeline(normalPipeline);
    normalPass.setBindGroup(0, normalGroup);
    normalPass.dispatchWorkgroups(workgroups(outW), workgroups(outH));
    normalPass.end();

    device.queue.submit([encoder.finish()]);
  } catch (e) {
    for (const o of outputs) o.destroy();
    params.destroy();
    rects.destroy();
    throw e;
  } finally {
    used = stopTracking();
    // The 1×1 fallback and the wear scratch (JFA seeds) are bound only by these submits; free them even if encoding
    // throws.
    ownStructure?.destroy();
    for (const r of wearResources) r.destroy();
    wearUniforms.buffer.destroy();
  }
  let heightRangeM: [number, number];
  try {
    // A WGSL or layout error would otherwise leave blank maps.
    await pipelinesReady(used);
    heightRangeM = await reduceHeightRange(ctx, height);
  } catch (e) {
    for (const o of outputs) o.destroy();
    throw e;
  } finally {
    params.destroy();
    rects.destroy();
  }
  if (!input.keepMatNormal) matNormal.destroy();

  return {
    baseColor, normal, height, macroHeight, roughness, metallic, ao, rectId, pieceId, jointDistM, loss, border, wearMask,
    heightRangeM, ...(input.keepMatNormal ? { matNormal } : {}),
  };
}

/**
 * Height normalized by heightRangeM into rgba8unorm (grey, A = 255), for export and preview. The work is submitted
 * before the first await, so `maps.height` may be destroyed as soon as this returns its promise; it rejects (and frees
 * the output) if its pipeline failed validation.
 */
export async function heightToRgba8(ctx: GpuContext, maps: Pick<AtlasMaps, 'height' | 'heightRangeM'>): Promise<GPUTexture> {
  const { device } = ctx;
  const { height } = maps;
  const out = device.createTexture({ size: [height.width, height.height], format: 'rgba8unorm', usage: OUT_USAGE });
  const range = device.createBuffer({ size: 8, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(range, 0, new Float32Array(maps.heightRangeM));
  const { value: pipeline, ready } = cachedEntry(device, 'heightToRgba8', () => device.createComputePipeline({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: heightToRgba8Wgsl }), entryPoint: 'main' },
  }));
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
  try {
    await pipelinesReady([ready]);
  } catch (e) {
    out.destroy();
    throw e;
  }
  return out;
}

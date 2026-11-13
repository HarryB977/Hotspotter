import { test, expect } from '@playwright/test';
import type { DirtParams, WearParams } from '@hotspotter/core';

// ---------------------------------------------------------------------------
// Wear loss pass (Task 8).
// 'pair' layout: two 1 × 2 m rects side by side (512 × 512 reference px, 2 m wide, 256 px/m), default groove.
// 'trim' layout: one 4 × 0.06 m rect (2000 × 100 reference px, 4 m wide, 500 px/m).
// Brick material: syntheticBrick 256 px, tile 1 × 1 m (bricks 0.25 × 0.125 m, joints 1.56 cm), uploaded as
// height + albedo and analysed on the CPU (analyzeStructure).
// ---------------------------------------------------------------------------

interface ComposeOpts {
  /** 'flat' is a uniform mid-grey albedo with no other map (and no structure). */
  material?: 'brick' | 'albedo' | 'flat';
  /** Structure analysis input: the height map, the inverted albedo luma, or none. Default: height for brick. */
  structure?: 'height' | 'invertedLuma' | false;
  /** 'trim' is 4 × 0.06 m (500 px/m); 'trim12' is 1 × 0.012 m (1000 px/m). */
  layout?: 'pair' | 'trim' | 'trim12';
  resolutionPx?: number;
  /** Merged over DEFAULT_WEAR; null composes without wear. */
  wear?: Partial<WearParams> | null;
  /** Constant masks, or half black: the left (atlas u < 0.5) or the top (v < 0.5) half; the rest is white. */
  mask?: 'black' | 'white' | 'leftBlack' | 'topBlack';
  grainAxis?: 'x' | 'y' | null;
  /** Per-rect rotate90 with origin 0; default: placeMaterial without rotation. */
  rotate?: boolean[];
  /** Also upload a gentle procedural normal map (xy up to 0.1 each), so the normal pass runs Sobel on the macro height. */
  normalMap?: boolean;
  /** Use syntheticBrick({ colour: true }) as albedo (red bricks, light joints). */
  colour?: boolean;
  /** Merged over DEFAULT_DIRT; omitted composes without dirt. */
  dirt?: Partial<DirtParams>;
  /** Second PBR set bound as substrateMaterial: pure red, or a 4 × 4 red / blue checker (256 px). */
  substrate?: 'red' | 'checker';
  /** tileSizeM of the substrate set (square), default 1. */
  substrateTileM?: number;
  /** Also upload the grey brick image as the AO map (the same image as the non-colour albedo). */
  aoMap?: boolean;
  /** ComposeInput.bandRows: rows per banded dispatch (default 1024). */
  bandRows?: number;
  /** Compose on this context instead of the shared one. */
  ctx?: import('@hotspotter/engine').GpuContext;
  /**
   * Called right before composeAtlas. A synchronous hook keeps composeAtlas in the same task (no await in between);
   * a returned promise is awaited first.
   */
  beforeCompose?: (ctx: import('@hotspotter/engine').GpuContext) => void | Promise<void>;
}

interface WearProbe {
  w: number;
  h: number;
  /** Size of the loss texture (1 × 1 without wear). */
  lossSize: [number, number];
  /** Decoded loss texels: [loss, depthM] per pixel. */
  loss: Float32Array;
  rectId: Uint32Array;
  jointDistM: Float32Array;
  /** Metres from pixel (x, y) to the visible edge of its rect, or -1 outside every rect. */
  edgeM(x: number, y: number): number;
  /** Metres per output pixel. */
  mpp: number;
  rects: { x: number; y: number; w: number; h: number }[];
  refScale: number;
  ppm: number;
  halfGroovePx: number;
  grooveWidthM: number;
  /** Final height and macro height, metres. */
  height: Float32Array;
  macroHeight: Float32Array;
  /** RGBA f32 material detail normal in atlas space (matNormal, R41). */
  matNormal: Float32Array;
  /** RGBA8 final normal (GL). */
  normal: Uint8Array;
  /** Signed metres to the loss contour (negative inside), or null when it is a 1 × 1 placeholder. */
  border: Float32Array | null;
  /** Red channel of wearMask (0..255), or null when it is a 1 × 1 placeholder. */
  wearMask: Uint8Array | null;
  /** Sizes of the border and wearMask textures. */
  borderSize: [number, number];
  wearMaskSize: [number, number];
  /** Structure the analysis found (null when composed without structure). */
  structureType: string | null;
  jointFraction: number;
  /** Raw texel bytes of the maps compared by the no-wear identity test, plus heightRangeM. */
  bytes: Record<'baseColor' | 'normal' | 'height' | 'roughness' | 'metallic' | 'ao' | 'rectId' | 'pieceId' | 'jointDistM', Uint8Array>;
  heightRangeM: [number, number];
  /** 1 where the loss holds the groove-floor marker (lossR < 0, R31); `loss` reads it as 0. */
  floorMarker: Uint8Array;
  /** Placement origin (material metres) of each rect, and whether it is rotated. */
  originM: [number, number][];
  rotate90: boolean[];
}

declare global {
  interface Window {
    __t8?: { compose(opts: ComposeOpts): Promise<WearProbe> };
  }
}

test.describe.configure({ timeout: 120_000 });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__hs);
  await page.evaluate(() => {
    const { core, engine } = window.__hs!;
    let ctxP: Promise<import('@hotspotter/engine').GpuContext> | null = null;
    const brickOpts = { size: 256, courseH: 32, brickW: 64, joint: 4, jointH: 0.2, brickH: 0.8 };
    const brick = core.syntheticBrick(brickOpts);
    const colourBrick = core.syntheticBrick({ ...brickOpts, colour: true });
    // Gentle procedural normal map: tilt up to 0.1 in x and y.
    const normalRgba = new Uint8Array(64 * 64 * 4);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const nx = 0.1 * Math.sin((2 * Math.PI * x) / 16), ny = 0.1 * Math.cos((2 * Math.PI * y) / 24);
        const l = Math.hypot(nx, ny, 1);
        normalRgba.set([nx / l, ny / l, 1 / l].map((v) => Math.round((v * 0.5 + 0.5) * 255)).concat(255), (y * 64 + x) * 4);
      }
    }
    const toBitmap = (rgba: Uint8Array, w: number, h: number) =>
      createImageBitmap(new ImageData(new Uint8ClampedArray(rgba), w, h), {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
      });
    const readTexels = async (ctx: import('@hotspotter/engine').GpuContext, tex: GPUTexture, bpt: number) => {
      const { device } = ctx;
      const rowBytes = tex.width * bpt;
      const bytesPerRow = Math.ceil(rowBytes / 256) * 256;
      const buffer = device.createBuffer({ size: bytesPerRow * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = device.createCommandEncoder();
      enc.copyTextureToBuffer({ texture: tex }, { buffer, bytesPerRow }, [tex.width, tex.height]);
      device.queue.submit([enc.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const padded = new Uint8Array(buffer.getMappedRange());
      const out = new Uint8Array(rowBytes * tex.height);
      for (let y = 0; y < tex.height; y++) out.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + rowBytes), y * rowBytes);
      buffer.unmap();
      buffer.destroy();
      return out.buffer;
    };
    // Inverse of WGSL pack2x16float for one half.
    const halfToFloat = (h: number) => {
      const sign = h & 0x8000 ? -1 : 1;
      const e = (h >> 10) & 31;
      const f = h & 1023;
      if (e === 0) return sign * f * 2 ** -24;
      if (e === 31) return f ? Number.NaN : sign * Infinity;
      return sign * (1 + f / 1024) * 2 ** (e - 15);
    };
    const maskTexture = (ctx: import('@hotspotter/engine').GpuContext, kind: NonNullable<ComposeOpts['mask']>) => {
      const n = 64;
      const bytes = new Uint8Array(n * n * 4);
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const black = kind === 'black' || (kind === 'leftBlack' && x < n / 2) || (kind === 'topBlack' && y < n / 2);
          const v = black ? 0 : 255;
          bytes.set([v, v, v, 255], (y * n + x) * 4);
        }
      }
      const tex = ctx.device.createTexture({
        size: [n, n], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      ctx.device.queue.writeTexture({ texture: tex }, bytes, { bytesPerRow: n * 4 }, [n, n]);
      return tex;
    };
    const flatGrey = new Uint8Array(16 * 16 * 4).fill(128);
    const red = new Uint8Array(16 * 16 * 4);
    for (let i = 0; i < 16 * 16; i++) red.set([255, 0, 0, 255], i * 4);
    // 4 × 4 cells of 64 px: red where (cx + cy) is even (image rows from the top), blue otherwise.
    const checker = new Uint8Array(256 * 256 * 4);
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) checker.set(((x >> 6) + (y >> 6)) % 2 ? [0, 0, 255, 255] : [255, 0, 0, 255], (y * 256 + x) * 4);
    }
    window.__t8 = {
      async compose({
        material = 'brick', structure, layout: kind = 'pair', resolutionPx = 1024, wear = {}, mask, grainAxis = null, rotate,
        normalMap = false, colour = false, dirt, substrate, substrateTileM = 1, aoMap = false, bandRows,
        ctx: ownCtx, beforeCompose,
      }) {
        const ctx = ownCtx ?? await (ctxP ??= engine.initGpu());
        const groove = core.DEFAULT_GROOVE;
        const structureFrom = material === 'flat' ? false : structure ?? (material === 'brick' ? 'height' : false);
        const layout = kind === 'pair'
          ? {
            version: 1 as const, widthPx: 512, heightPx: 512, worldWidthM: 2, groove,
            rects: [
              core.makeRect({ id: 'a', x: 0, y: 0, w: 256, h: 512 }),
              core.makeRect({ id: 'b', x: 256, y: 0, w: 256, h: 512 }),
            ],
          }
          : kind === 'trim'
            ? {
              version: 1 as const, widthPx: 2000, heightPx: 100, worldWidthM: 4, groove,
              rects: [core.makeRect({ id: 't', x: 0, y: 35, w: 2000, h: 30 })],
            }
            : {
              version: 1 as const, widthPx: 1000, heightPx: 40, worldWidthM: 1, groove,
              rects: [core.makeRect({ id: 't', x: 0, y: 14, w: 1000, h: 12 })],
            };
        const tileSizeM: [number, number] = [1, 1];
        const settings = {
          name: 't8', files: {}, normalConvention: 'gl' as const, roughnessIsGloss: false, tileSizeM,
          heightScaleM: 0.02, period: core.CONTINUOUS, allowRotation: false,
          orientation: { baseRotation: 0 as const, rule: 'fixed' as const },
        };
        const albedo = colour ? colourBrick.rgba : brick.rgba;
        const bmp = await toBitmap(brick.rgba, 256, 256);
        const albedoBmp = colour ? await toBitmap(albedo, 256, 256) : bmp;
        const images: Partial<Record<'baseColor' | 'height' | 'normal' | 'ao', ImageBitmap>> = {
          baseColor: material === 'flat' ? await toBitmap(flatGrey, 16, 16) : albedoBmp,
        };
        if (material === 'brick') images.height = bmp;
        if (normalMap) images.normal = await toBitmap(normalRgba, 64, 64);
        if (aoMap) images.ao = bmp;
        const gpuMaterial = engine.uploadMaterial(ctx, { settings, images });
        const substrateMaterial = substrate
          ? engine.uploadMaterial(ctx, {
            settings: { ...settings, name: 'sub', tileSizeM: [substrateTileM, substrateTileM] },
            images: { baseColor: substrate === 'red' ? await toBitmap(red, 16, 16) : await toBitmap(checker, 256, 256) },
          })
          : undefined;
        const analysis = structureFrom === 'height'
          ? core.analyzeStructure(brick.gray, tileSizeM)
          : structureFrom === 'invertedLuma'
            ? core.analyzeStructure(core.toGray(albedo, 256, 256, 'invertedLuma'), tileSizeM)
            : null;
        const gpuStructure = analysis ? engine.uploadStructure(ctx, analysis) : undefined;
        const placements = rotate
          ? layout.rects.map((r, i) => ({ rectId: r.id, originM: [0, 0] as [number, number], rotate90: !!rotate[i] }))
          : core.placeMaterial(layout, core.CONTINUOUS, {
            variation: 0, seed: 1, materialAllowsRotation: false, tileSizeM, orientation: settings.orientation,
          });
        const maskTex = mask ? maskTexture(ctx, mask) : undefined;
        const wearParams = wear === null ? undefined : {
          ...core.DEFAULT_WEAR, ...wear,
          mask: { ...core.DEFAULT_WEAR.mask, enabled: !!mask, ...(wear.mask ?? {}) },
        };
        const hook = beforeCompose?.(ctx);
        if (hook) await hook;
        const maps = await engine.composeAtlas(ctx, {
          layout, material: gpuMaterial, placements, resolutionPx, structure: gpuStructure,
          wear: wearParams, mask: maskTex, grainAxis, substrateMaterial,
          dirt: dirt ? { ...core.DEFAULT_DIRT, ...dirt } : undefined,
          bandRows, keepMatNormal: true,
        } as import('@hotspotter/engine').ComposeInput);
        const packed = new Uint32Array(await readTexels(ctx, maps.loss, 4));
        const loss = new Float32Array(packed.length * 2);
        const floorMarker = new Uint8Array(packed.length);
        for (let i = 0; i < packed.length; i++) {
          // lossR < 0 marks the groove floor (R31): every reader treats it as 0.
          const lossR = halfToFloat(packed[i] & 0xffff);
          loss[2 * i] = Math.max(0, lossR);
          floorMarker[i] = lossR < 0 ? 1 : 0;
          loss[2 * i + 1] = halfToFloat(packed[i] >>> 16);
        }
        const rectIdBytes = await readTexels(ctx, maps.rectId, 4);
        const rectId = new Uint32Array(rectIdBytes);
        const jointDistBytes = await readTexels(ctx, maps.jointDistM, 4);
        const jointDistM = new Float32Array(jointDistBytes);
        const heightBytes = await readTexels(ctx, maps.height, 4);
        const matNormal = new Float32Array(Array.from(new Uint16Array(await readTexels(ctx, maps.matNormal!, 8)), halfToFloat));
        maps.matNormal!.destroy();
        const normalBytes = await readTexels(ctx, maps.normal, 4);
        const bytes = {
          baseColor: new Uint8Array(await readTexels(ctx, maps.baseColor, 4)),
          normal: new Uint8Array(normalBytes),
          height: new Uint8Array(heightBytes),
          roughness: new Uint8Array(await readTexels(ctx, maps.roughness, 4)),
          metallic: new Uint8Array(await readTexels(ctx, maps.metallic, 4)),
          ao: new Uint8Array(await readTexels(ctx, maps.ao, 4)),
          rectId: new Uint8Array(rectIdBytes),
          pieceId: new Uint8Array(await readTexels(ctx, maps.pieceId, 4)),
          jointDistM: new Uint8Array(jointDistBytes),
        };
        const extra = maps as unknown as Partial<Record<'macroHeight' | 'border' | 'wearMask', GPUTexture>>;
        const sizeOf = (t?: GPUTexture): [number, number] => (t ? [t.width, t.height] : [0, 0]);
        const big = (t?: GPUTexture) => !!t && t.width > 1;
        const macroHeight = extra.macroHeight ? new Float32Array(await readTexels(ctx, extra.macroHeight, 4)) : new Float32Array(0);
        const border = big(extra.border) ? new Float32Array(await readTexels(ctx, extra.border!, 4)) : null;
        const wearMask = big(extra.wearMask)
          ? new Uint8Array(await readTexels(ctx, extra.wearMask!, 4)).filter((_, i) => i % 4 === 0)
          : null;
        const borderSize = sizeOf(extra.border);
        const wearMaskSize = sizeOf(extra.wearMask);
        const w = maps.rectId.width;
        const h = maps.rectId.height;
        const lossSize: [number, number] = [maps.loss.width, maps.loss.height];
        const refScale = resolutionPx / layout.widthPx;
        const ppm = layout.widthPx / layout.worldWidthM;
        const halfGroovePx = 0.5 * groove.widthM * ppm;
        const rects = layout.rects.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h }));
        const m = maps;
        for (const t of [m.baseColor, m.normal, m.height, m.roughness, m.metallic, m.ao, m.rectId, m.pieceId, m.jointDistM, m.loss]) {
          t.destroy();
        }
        for (const t of [extra.macroHeight, extra.border, extra.wearMask]) t?.destroy();
        for (const t of Object.values(gpuMaterial.textures)) t.destroy();
        for (const t of Object.values(substrateMaterial?.textures ?? {})) t.destroy();
        gpuStructure?.destroy();
        maskTex?.destroy();
        return {
          w, h, lossSize, loss, rectId, jointDistM, rects, refScale, ppm, halfGroovePx, grooveWidthM: groove.widthM,
          height: new Float32Array(heightBytes), macroHeight, matNormal, normal: new Uint8Array(normalBytes), border, wearMask,
          borderSize, wearMaskSize, bytes, heightRangeM: maps.heightRangeM, floorMarker,
          originM: placements.map((p) => p.originM), rotate90: placements.map((p) => p.rotate90),
          structureType: analysis ? analysis.type : null, jointFraction: analysis ? analysis.jointFraction : 0,
          mpp: 1 / (ppm * refScale),
          edgeM(x: number, y: number) {
            const id = rectId[y * w + x];
            if (id === 0) return -1;
            const r = rects[id - 1];
            const px = (x + 0.5) / refScale;
            const py = (y + 0.5) / refScale;
            const e = Math.min(
              px - (r.x + halfGroovePx), r.x + r.w - halfGroovePx - px,
              py - (r.y + halfGroovePx), r.y + r.h - halfGroovePx - py,
            );
            return e / ppm;
          },
        };
      },
    };
  });
});

test('without wear the loss map is zero everywhere', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const m = await window.__t8!.compose({ wear: null });
    return { lost: m.loss.reduce((n, v) => n + (v !== 0 ? 1 : 0), 0), size: m.lossSize };
  });
  // A 1 x 1 placeholder means no wear (R29).
  expect(r.size).toEqual([1, 1]);
  expect(r.lost).toBe(0);
});

test('intensity 0 and minEdgeM 0 lose no pixel', async ({ page }) => {
  const lost = await page.evaluate(async () => {
    const m = await window.__t8!.compose({ wear: { intensity: 0, minEdgeM: 0 } });
    let n = 0;
    for (let i = 0; i < m.w * m.h; i++) if (m.loss[2 * i] > 0) n++;
    return n;
  });
  expect(lost).toBe(0);
});

test('minEdgeM 0.004 gives a guaranteed rim, never wider than 1.6 · minEdgeM', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const minEdge = 0.004;
    const m = await window.__t8!.compose({ wear: { intensity: 0, minEdgeM: minEdge } });
    const lostAt = (x: number, y: number) => m.loss[2 * (y * m.w + x)] === 1;
    // 200 points per rect around the perimeter; from each, walk inwards while e < minEdge.
    let checked = 0;
    let missing = 0;
    for (const r of m.rects) {
      const x0 = (r.x + m.halfGroovePx) * m.refScale, x1 = (r.x + r.w - m.halfGroovePx) * m.refScale;
      const y0 = (r.y + m.halfGroovePx) * m.refScale, y1 = (r.y + r.h - m.halfGroovePx) * m.refScale;
      const per = 2 * (x1 - x0 + y1 - y0);
      for (let k = 0; k < 200; k++) {
        let t = ((k + 0.5) / 200) * per;
        let sx: number, sy: number, dx: number, dy: number;
        if (t < x1 - x0) { sx = x0 + t; sy = y0; dx = 0; dy = 1; } else if ((t -= x1 - x0) < y1 - y0) {
          sx = x1; sy = y0 + t; dx = -1; dy = 0;
        } else if ((t -= y1 - y0) < x1 - x0) { sx = x1 - t; sy = y1; dx = 0; dy = -1; } else {
          t -= x1 - x0; sx = x0; sy = y1 - t; dx = 1; dy = 0;
        }
        let x = Math.min(m.w - 1, Math.floor(sx - (dx < 0 ? 1 : 0)));
        let y = Math.min(m.h - 1, Math.floor(sy - (dy < 0 ? 1 : 0)));
        for (let s = 0; s < 20; s++, x += dx, y += dy) {
          const e = m.edgeM(x, y);
          if (e < 0) continue;
          if (e >= minEdge) break;
          checked++;
          if (!lostAt(x, y)) missing++;
        }
      }
    }
    let tooFar = 0;
    for (let y = 0; y < m.h; y++) {
      for (let x = 0; x < m.w; x++) if (lostAt(x, y) && m.edgeM(x, y) > 1.6 * minEdge + m.mpp) tooFar++;
    }
    return { checked, missing, tooFar };
  });
  expect(r.checked).toBeGreaterThan(400);
  expect(r.missing).toBe(0);
  expect(r.tooFar).toBe(0);
});

test('with pieces and pieceBias 1, 90 % of the loss beyond the rim is within sizeM of a joint', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const m = await window.__t8!.compose({ wear: { pieceBias: 1, intensity: 1 } });
    let lost = 0;
    let nearJoint = 0;
    for (let y = 0; y < m.h; y++) {
      for (let x = 0; x < m.w; x++) {
        const i = y * m.w + x;
        if (m.loss[2 * i] !== 1 || m.edgeM(x, y) <= 0.004) continue;
        lost++;
        if (m.jointDistM[i] < 0.03) nearJoint++;
      }
    }
    return { lost, nearJoint };
  });
  expect(r.lost).toBeGreaterThan(1000);
  expect(r.nearJoint / r.lost).toBeGreaterThanOrEqual(0.9);
});

test('a black mask leaves only the rim; a white mask loses more than no mask', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const frac = (m: WearProbe) => {
      let inRect = 0;
      let lost = 0;
      for (let i = 0; i < m.w * m.h; i++) {
        if (m.rectId[i] === 0) continue;
        inRect++;
        if (m.loss[2 * i] === 1) lost++;
      }
      return lost / inRect;
    };
    const black = await window.__t8!.compose({ mask: 'black' });
    let beyondRim = 0;
    for (let y = 0; y < black.h; y++) {
      for (let x = 0; x < black.w; x++) {
        if (black.loss[2 * (y * black.w + x)] === 1 && black.edgeM(x, y) > 1.6 * 0.004 + black.mpp) beyondRim++;
      }
    }
    const none = frac(await window.__t8!.compose({}));
    const white = frac(await window.__t8!.compose({ mask: 'white' }));
    return { beyondRim, none, white };
  });
  expect(r.beyondRim).toBe(0);
  expect(r.none).toBeGreaterThan(0);
  expect(r.white).toBeGreaterThan(r.none);
});

test('a half-black mask keeps the loss beyond the rim in its white half (atlas UV, not flipped)', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const out: Record<string, { black: number; white: number }> = {};
    for (const mask of ['leftBlack', 'topBlack'] as const) {
      const m = await window.__t8!.compose({ mask, wear: { intensity: 1 } });
      let black = 0;
      let white = 0;
      for (let y = 0; y < m.h; y++) {
        for (let x = 0; x < m.w; x++) {
          if (m.loss[2 * (y * m.w + x)] !== 1 || m.edgeM(x, y) <= 1.6 * 0.004 + m.mpp) continue;
          const t = mask === 'leftBlack' ? (x + 0.5) / m.w : (y + 0.5) / m.h;
          // Skip the bilinear blend between the two halves of the 64-texel mask.
          if (Math.abs(t - 0.5) < 1 / 64) continue;
          if (t < 0.5) black++;
          else white++;
        }
      }
      out[mask] = { black, white };
    }
    return out;
  });
  for (const k of ['leftBlack', 'topBlack']) {
    expect(r[k].black).toBe(0);
    expect(r[k].white).toBeGreaterThan(1000);
  }
});

test('the loss is deterministic and the seed changes it', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const a = await window.__t8!.compose({ wear: { seed: 3 } });
    const b = await window.__t8!.compose({ wear: { seed: 3 } });
    const c = await window.__t8!.compose({ wear: { seed: 4 } });
    let same = true;
    for (let i = 0; i < a.loss.length; i++) if (a.loss[i] !== b.loss[i]) { same = false; break; }
    let lost = 0;
    let differ = 0;
    for (let i = 0; i < a.w * a.h; i++) {
      if (a.loss[2 * i] === 1) lost++;
      if (a.loss[2 * i] !== c.loss[2 * i]) differ++;
    }
    return { same, lost, differ };
  });
  expect(r.same).toBe(true);
  expect(r.lost).toBeGreaterThan(1000);
  expect(r.differ).toBeGreaterThan(0.3 * r.lost);
});

test('Review Focus 3: a 6 cm trim with widthM 0.2 loses nothing beyond a third of its height', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const m = await window.__t8!.compose({ layout: 'trim', resolutionPx: 2000, wear: { widthM: 0.2, intensity: 1, pieceBias: 0 } });
    let lost = 0;
    let tooFar = 0;
    for (let y = 0; y < m.h; y++) {
      for (let x = 0; x < m.w; x++) {
        if (m.loss[2 * (y * m.w + x)] !== 1) continue;
        lost++;
        if (m.edgeM(x, y) > 0.02 + m.mpp) tooFar++;
      }
    }
    return { lost, tooFar };
  });
  expect(r.lost).toBeGreaterThan(0);
  expect(r.tooFar).toBe(0);
});

test('Review Focus 3 (R28): on a 1.2 cm trim the rim shrinks to half of wEff and the centre line survives', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const opts = { layout: 'trim12' as const, resolutionPx: 4096 };
    const scan = (m: WearProbe, wEff: number) => {
      let lost = 0;
      let beyondRim = 0;
      let beyondWEff = 0;
      let centreLost = 0;
      for (let y = 0; y < m.h; y++) {
        for (let x = 0; x < m.w; x++) {
          const e = m.edgeM(x, y);
          if (e < 0 || m.loss[2 * (y * m.w + x)] !== 1) continue;
          lost++;
          if (e > 0.5 * wEff * 1.6 + m.mpp) beyondRim++;
          if (e > wEff + m.mpp) beyondWEff++;
          // Centre line of the visible trim: the visible half height minus one pixel.
          if (e > (0.012 - m.grooveWidthM) / 2 - m.mpp) centreLost++;
        }
      }
      return { lost, beyondRim, beyondWEff, centreLost };
    };
    const probe = await window.__t8!.compose({ ...opts, wear: { intensity: 0, widthM: 0.2, pieceBias: 0 } });
    // wEff uses the visible side: the rect minus the groove floor.
    const wEff = 0.33 * (0.012 - probe.grooveWidthM);
    const rimOnly = scan(probe, wEff);
    const full = scan(await window.__t8!.compose({ ...opts, wear: { intensity: 1, widthM: 0.2, pieceBias: 0 } }), wEff);
    return { rimOnly, full };
  });
  expect(r.rimOnly.lost).toBeGreaterThan(0);
  expect(r.rimOnly.beyondRim).toBe(0);
  expect(r.rimOnly.centreLost).toBe(0);
  expect(r.full.beyondWEff).toBe(0);
  expect(r.full.centreLost).toBe(0);
});

test('Review Focus 5: the loss at 1024 and 2048 matches in fraction and per pixel', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const wear = { intensity: 1, widthM: 0.2, pieceBias: 0 };
    const frac = (m: WearProbe) => {
      let inRect = 0;
      let lost = 0;
      for (let i = 0; i < m.w * m.h; i++) {
        if (m.rectId[i] === 0) continue;
        inRect++;
        if (m.loss[2 * i] === 1) lost++;
      }
      return lost / inRect;
    };
    const low = await window.__t8!.compose({ resolutionPx: 1024, wear });
    const high = await window.__t8!.compose({ resolutionPx: 2048, wear });
    // 2× box downsample of the 2048 loss (majority of the 2 × 2 block) against the 1024 pixel.
    let n = 0;
    let agree = 0;
    for (let y = 0; y < low.h; y++) {
      for (let x = 0; x < low.w; x++) {
        if (low.rectId[y * low.w + x] === 0) continue;
        let sum = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) sum += high.loss[2 * ((2 * y + dy) * high.w + 2 * x + dx)];
        n++;
        if ((sum >= 2) === (low.loss[2 * (y * low.w + x)] === 1)) agree++;
      }
    }
    return { low: frac(low), high: frac(high), agreement: agree / n };
  });
  expect(r.low).toBeGreaterThan(0.1);
  expect(Math.abs(r.low - r.high)).toBeLessThan(0.03);
  expect(Math.abs(r.low - r.high) / r.low).toBeLessThan(0.15);
  expect(r.agreement).toBeGreaterThan(0.85);
});

test('Review Focus 1: an albedo-only material without structure still loses material', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const m = await window.__t8!.compose({ material: 'albedo', structure: false, wear: { intensity: 0.8 } });
    let beyondRim = 0;
    for (let y = 0; y < m.h; y++) {
      for (let x = 0; x < m.w; x++) {
        if (m.loss[2 * (y * m.w + x)] === 1 && m.edgeM(x, y) > 1.6 * 0.004 + m.mpp) beyondRim++;
      }
    }
    return { beyondRim };
  });
  expect(r.beyondRim).toBeGreaterThan(1000);
});

test('Review Focus 1: an albedo-only material analysed from its inverted luma loses material', async ({ page }) => {
  const r = await page.evaluate(async () => {
    // Red bricks with light joints: the inverted luma makes the joints the low relief.
    const m = await window.__t8!.compose({ material: 'albedo', colour: true, structure: 'invertedLuma', wear: { intensity: 0.8 } });
    let beyondRim = 0;
    for (let y = 0; y < m.h; y++) {
      for (let x = 0; x < m.w; x++) {
        if (m.loss[2 * (y * m.w + x)] === 1 && m.edgeM(x, y) > 1.6 * 0.004 + m.mpp) beyondRim++;
      }
    }
    return { beyondRim, type: m.structureType, jointFraction: m.jointFraction };
  });
  expect(r.type).toBe('pieces');
  expect(r.jointFraction).toBeGreaterThan(0);
  expect(r.beyondRim).toBeGreaterThan(1000);
});

test('splinter cells stretch along the grain axis and turn with a rotated rect', async ({ page }) => {
  const r = await page.evaluate(async () => {
    // Nearly flat potential (wEff 0.33 m, e in 1–6 cm) so the edge falloff does not orient the shapes.
    const m = await window.__t8!.compose({
      material: 'albedo', structure: false, grainAxis: 'y', rotate: [false, true],
      wear: { family: 'splinter', intensity: 0.5, widthM: 2, pieceBias: 0 },
    });
    const inBand = (x: number, y: number) => {
      const e = m.edgeM(x, y);
      return e > 0.01 && e < 0.06;
    };
    const runs = [0, 0].map(() => ({ x: 0, y: 0 }));
    for (let y = 0; y < m.h - 1; y++) {
      for (let x = 0; x < m.w - 1; x++) {
        const i = y * m.w + x;
        const id = m.rectId[i];
        if (id === 0 || !inBand(x, y)) continue;
        const v = m.loss[2 * i];
        if (m.rectId[i + 1] === id && inBand(x + 1, y) && m.loss[2 * (i + 1)] !== v) runs[id - 1].x++;
        if (m.rectId[i + m.w] === id && inBand(x, y + 1) && m.loss[2 * (i + m.w)] !== v) runs[id - 1].y++;
      }
    }
    return runs;
  });
  // Transitions per direction: few along the grain. Rect a (unrotated) has the material Y grain along atlas Y;
  // rect b (rotated) along atlas X.
  expect(r[0].y).toBeGreaterThan(100);
  expect(r[0].x / r[0].y).toBeGreaterThan(2);
  expect(r[1].x).toBeGreaterThan(100);
  expect(r[1].y / r[1].x).toBeGreaterThan(2);
});

test('packWear byte layout and sanitising of saved values', async ({ page }) => {
  const r = await page.evaluate(() => {
    const { core, engine } = window.__hs!;
    const w = {
      ...core.DEFAULT_WEAR, intensity: 0.25, widthM: 0.05, minEdgeM: 0.003, sizeM: 0.02, depthM: 0.007,
      bandM: 0.008, microM: 0.001, pieceBias: 0.5, edgeTone: 0.375, seed: 0xdeadbeef,
      mask: { enabled: true, strength: 0.75, invert: true },
    };
    const d = {
      enabled: true, cavity: 0.5, runoff: 0.25, runoffLengthM: 0.625, tint: [0.25, 0.5, 0.75] as [number, number, number],
    };
    const sub = { source: 'secondSet' as const, hueShift: 30, satMul: 0.5, valMul: 0.25, roughAdd: 0.125 };
    const buf = engine.packWear({ ...w, family: 'dent', substrate: sub }, d, core.WEAR_FAMILIES.chipping, {
      hasPieces: true, grainAxis: 'y', maskBound: true, substrate: { tileSizeM: [0.5, 0.75], roughnessIsGloss: true },
    });
    const dv = new DataView(buf);
    const f = (o: number) => dv.getFloat32(o, true);
    const u = (o: number) => dv.getUint32(o, true);
    const layout = {
      bytes: buf.byteLength, enabled: u(0), intensity: f(4), widthM: f(8), minEdgeM: f(12), sizeM: f(16),
      depthM: f(20), bandM: f(24), microM: f(28), pieceBias: f(32), edgeTone: f(36), maskStrength: f(40),
      maskEnabled: u(44), maskInvert: u(48), hasPieces: u(52), grainAxis: u(56), cellMix: f(60), anisotropy: f(64),
      steps: u(68), loses: u(72), polish: f(76), cavity: f(80), runoff: f(84), runoffLengthM: f(88),
      tint: [f(92), f(96), f(100)], family: u(104), substrateSource: u(108), hueShift: f(112), satMul: f(116),
      valMul: f(120), roughAdd: f(124), substrateTileM: [f(128), f(132)], substrateGloss: u(136),
    };
    const bad = engine.packWear(
      { ...core.DEFAULT_WEAR, intensity: Number.NaN, widthM: -1, sizeM: Infinity, pieceBias: 3, mask: { enabled: false, strength: 2, invert: false } },
      core.DEFAULT_DIRT, core.WEAR_FAMILIES.brittle, { hasPieces: false, grainAxis: null, maskBound: false },
    );
    const bv = new DataView(bad);
    // secondSet without a bound substrate set falls back to the interior.
    const unbound = new DataView(engine.packWear(
      { ...core.DEFAULT_WEAR, substrate: sub }, core.DEFAULT_DIRT, core.WEAR_FAMILIES.brittle,
      { hasPieces: false, grainAxis: null, maskBound: false },
    )).getUint32(108, true);
    const sanitized = {
      intensity: bv.getFloat32(4, true), widthM: bv.getFloat32(8, true), sizeM: bv.getFloat32(16, true),
      pieceBias: bv.getFloat32(32, true), maskStrength: bv.getFloat32(40, true), maskEnabled: bv.getUint32(44, true),
    };
    // runoffLengthM is clamped to the atlas height (R33); a shorter one is kept.
    const tall = { ...core.DEFAULT_DIRT, runoffLengthM: 5 };
    const clampExtra = { hasPieces: false, grainAxis: null, maskBound: false, atlasHeightM: 0.75 };
    const runoffClamp = [
      new DataView(engine.packWear(core.DEFAULT_WEAR, tall, core.WEAR_FAMILIES.brittle, clampExtra)).getFloat32(88, true),
      new DataView(engine.packWear(core.DEFAULT_WEAR, { ...tall, runoffLengthM: 0.5 }, core.WEAR_FAMILIES.brittle, clampExtra))
        .getFloat32(88, true),
    ];
    return { layout, sanitized, unbound, runoffClamp };
  });
  expect(r.layout).toEqual({
    bytes: 144, enabled: 1, intensity: 0.25, widthM: expect.closeTo(0.05, 7), minEdgeM: expect.closeTo(0.003, 7),
    sizeM: expect.closeTo(0.02, 7), depthM: expect.closeTo(0.007, 7), bandM: expect.closeTo(0.008, 7),
    microM: expect.closeTo(0.001, 7), pieceBias: 0.5, edgeTone: 0.375, maskStrength: 0.75, maskEnabled: 1,
    maskInvert: 1, hasPieces: 1, grainAxis: 2, cellMix: expect.closeTo(0.6, 6), anisotropy: 1, steps: 2, loses: 1,
    polish: expect.closeTo(0.1, 6), cavity: 0.5, runoff: 0.25, runoffLengthM: 0.625,
    tint: [0.25, 0.5, 0.75], family: 4, substrateSource: 1, hueShift: 30, satMul: 0.5, valMul: 0.25, roughAdd: 0.125,
    substrateTileM: [0.5, 0.75], substrateGloss: 1,
  });
  expect(r.unbound).toBe(0);
  expect(r.runoffClamp).toEqual([0.75, 0.5]);
  expect(r.sanitized).toEqual({
    intensity: 0.5, widthM: 0, sizeM: expect.closeTo(0.03, 7), pieceBias: 1, maskStrength: 1, maskEnabled: 0,
  });
});

// ---------------------------------------------------------------------------
// Task 9: border distance and height composite.
// ---------------------------------------------------------------------------

test('without wear the compose matches a wear compose that loses nothing (normal within 1 LSB), with and without dirt', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const out: Record<string, unknown> = {};
    const cases = {
      heightOnly: { normalMap: false }, normalMap: { normalMap: true }, dirt: { normalMap: false, dirt: { runoff: 1 } },
      // A real AO map moves height AO onto the macro height (R33) in both paths.
      aoMap: { normalMap: false, aoMap: true, dirt: { cavity: 1 } },
    };
    for (const [name, opts] of Object.entries(cases)) {
      // widthM 0 disables edge wear entirely (R30): the wear passes run but change nothing, edge tone included. Height
      // AO and dirt run in both paths.
      const plain = await window.__t8!.compose({ ...opts, wear: null });
      const zero = await window.__t8!.compose({ ...opts, wear: { widthM: 0 } });
      const differing: string[] = [];
      for (const k of ['baseColor', 'height', 'roughness', 'metallic', 'ao', 'rectId', 'pieceId', 'jointDistM'] as const) {
        const a = plain.bytes[k], b = zero.bytes[k];
        if (a.length !== b.length || a.some((v, i) => v !== b[i])) differing.push(k);
      }
      let normalMaxLsb = 0;
      for (let i = 0; i < plain.bytes.normal.length; i++) {
        normalMaxLsb = Math.max(normalMaxLsb, Math.abs(plain.bytes.normal[i] - zero.bytes.normal[i]));
      }
      out[name] = {
        differing, normalMaxLsb, sameRange: plain.heightRangeM.every((v, i) => v === zero.heightRangeM[i]),
        border: plain.borderSize, wearMask: plain.wearMaskSize, zeroBorder: zero.borderSize,
      };
    }
    return out;
  });
  for (const k of ['heightOnly', 'normalMap', 'dirt', 'aoMap']) {
    expect(r[k]).toEqual({
      differing: [], normalMaxLsb: expect.any(Number), sameRange: true, border: [1, 1], wearMask: [1, 1],
      zeroBorder: [1024, 1024],
    });
    expect((r[k] as { normalMaxLsb: number }).normalMaxLsb).toBeLessThanOrEqual(1);
  }
});

test('JFA: border on a synthetic 40 px disc is -40 px at the centre and +10 px 10 px outside', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { engine } = window.__hs!;
    const ctx = await engine.initGpu();
    const { device } = ctx;
    // Disc centred on the centre of pixel (120, 96).
    const w = 256, h = 200, px = 120, py = 96, cx = px + 0.5, cy = py + 0.5, radius = 40;
    const mpp = 0.001;
    const bandM = 12 * mpp; // clamp 4 · bandM = 48 px
    const texels = new Uint32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // pack2x16float(1, depth): half 1.0 = 0x3c00 in the low half.
        if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) < radius) texels[y * w + x] = 0x3c00 | (0x1c19 << 16);
      }
    }
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
    const loss = device.createTexture({ size: [w, h], format: 'r32uint', usage });
    device.queue.writeTexture({ texture: loss }, texels, { bytesPerRow: w * 4 }, [w, h]);
    const border = device.createTexture({ size: [w, h], format: 'r32float', usage });
    const rectId = device.createTexture({ size: [w, h], format: 'r32uint', usage });
    device.queue.writeTexture({ texture: rectId }, new Uint32Array(w * h).fill(1), { bytesPerRow: w * 4 }, [w, h]);
    const enc = device.createCommandEncoder();
    const res = engine.encodeBorder(device, enc, { loss, rectId, border, bandM, metresPerPx: mpp });
    device.queue.submit([enc.finish()]);
    res.destroy();
    const bytesPerRow = Math.ceil((w * 4) / 256) * 256;
    const buf = device.createBuffer({ size: bytesPerRow * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc2 = device.createCommandEncoder();
    enc2.copyTextureToBuffer({ texture: border }, { buffer: buf, bytesPerRow }, [w, h]);
    device.queue.submit([enc2.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const f = new Float32Array(buf.getMappedRange().slice(0));
    buf.unmap();
    buf.destroy();
    loss.destroy();
    border.destroy();
    rectId.destroy();
    const at = (x: number, y: number) => f[y * (bytesPerRow / 4) + x] / mpp;
    // Pixel centres 10 px beyond the disc along four directions.
    const outside = [at(px + 50, py), at(px - 50, py), at(px, py + 50), at(px, py - 50)];
    let min = Infinity, max = -Infinity;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { min = Math.min(min, at(x, y)); max = Math.max(max, at(x, y)); }
    return { centre: at(px, py), outside, min, max, far: at(w - 1, h - 1) };
  });
  expect(Math.abs(r.centre - -40)).toBeLessThanOrEqual(1);
  for (const v of r.outside) expect(Math.abs(v - 10)).toBeLessThanOrEqual(1);
  // Clamped to ±4 · bandM; far pixels have no seed within range.
  expect(r.min).toBeGreaterThanOrEqual(-48 - 1e-3);
  expect(r.max).toBeLessThanOrEqual(48 + 1e-3);
  expect(r.far).toBeCloseTo(48, 3);
});

/** Compares a wear compose against the same compose without wear (d = wear height − material height). */
/** Minimum share of fracture-band pixels below -0.1 · 0.15 · depthM where the crack cells are at least a pixel. */
const CRACKED_MIN = 0.1;

async function wearHeight(page: import('@playwright/test').Page, opts: ComposeOpts) {
  return page.evaluate(async (o) => {
    const plain = await window.__t8!.compose({ ...o, wear: null });
    const m = await window.__t8!.compose(o);
    const d = new Float32Array(m.w * m.h);
    for (let i = 0; i < d.length; i++) d[i] = m.height[i] - plain.height[i];
    let contour = 0;
    let maxSlope = 0;
    let belowLimit = 0;
    let bandSum = 0, bandN = 0, intactSum = 0, intactN = 0, bandCracked = 0;
    const bandM = o.wear?.bandM ?? 0.006;
    for (let y = 1; y < m.h - 1; y++) {
      for (let x = 1; x < m.w - 1; x++) {
        const i = y * m.w + x;
        if (m.rectId[i] === 0) continue;
        // h_final ≥ h_material − depthM − microM.
        if (m.height[i] < plain.height[i] - 0.006 - 0.0005) belowLimit++;
        const b = m.border![i];
        if (b > 0 && b < bandM) {
          bandSum += d[i];
          bandN++;
          if (d[i] < -0.1 * 0.15 * 0.006) bandCracked++;
        }
        if (b > bandM && b < 2 * bandM) { intactSum += d[i]; intactN++; }
        if (!(m.loss[2 * i] > 0.5)) continue;
        const nb = [i - 1, i + 1, i - m.w, i + m.w];
        if (!nb.some((j) => !(m.loss[2 * j] > 0.5) && m.rectId[j] === m.rectId[i])) continue;
        // Contour pixel: the steepest wear-height step to any same-rect neighbour.
        contour++;
        for (const k of nb) if (m.rectId[k] === m.rectId[i]) maxSlope = Math.max(maxSlope, Math.abs(d[k] - d[i]) / m.mpp);
      }
    }
    return {
      contour, maxSlope, belowLimit, bandMean: bandSum / bandN, bandN, intactMean: intactSum / intactN, intactN,
      crackedFraction: bandCracked / bandN,
    };
  }, opts);
}

test('wear height: no cliff at the loss contour, depth limit, and a fracture band around each break', async ({ page }) => {
  // [resolution, bandM]: mpp is 1.95 mm at 1024 and 0.98 mm at 2048; crack cells are 0.25 · bandM.
  for (const [resolutionPx, bandM] of [[1024, 0.006], [2048, 0.006], [1024, 0.012]]) {
    const r = await wearHeight(page, { resolutionPx, wear: { intensity: 0.8, bandM } });
    expect(r.contour).toBeGreaterThan(500);
    expect(r.maxSlope).toBeLessThan((0.006 / bandM) * 1.5);
    expect(r.belowLimit).toBe(0);
    expect(r.bandN).toBeGreaterThan(1000);
    expect(r.intactN).toBeGreaterThan(1000);
    expect(r.intactMean).toBe(0);
    if (0.25 * bandM >= 2 / resolutionPx) {
      // Resolved cracks: a real fracture band, by its mean drop and a share of clearly cracked pixels, both relative
      // to 0.15 · depthM.
      expect(r.bandMean).toBeLessThan(-0.05 * 0.15 * 0.006);
      expect(r.crackedFraction).toBeGreaterThan(CRACKED_MIN);
    } else {
      // Sub-pixel cracks are anti-aliased (R32d) into a shallow even drop: the volume stays, no pixel is deep.
      expect(r.bandMean).toBeLessThan(-0.025 * 0.15 * 0.006);
    }
  }
});

test('normals follow the macro height and the detail normal fades inside the loss', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const m = await window.__t8!.compose({ normalMap: true, wear: { intensity: 0.8 } });
    const { w, h, mpp } = m;
    const at = (x: number, y: number) => Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x));
    const H = (x: number, y: number) => m.macroHeight[at(x, y)];
    // The material's own relief (final − macro height) and its detail normal, for the R40/R41 dominance rule.
    const R = (x: number, y: number) => m.height[at(x, y)] - m.macroHeight[at(x, y)];
    // Faded by wearMask towards (0, 0, 1), as normalFromHeight and checkNormal do.
    const detailSlope = (i: number) => {
      const t = m.wearMask ? m.wearMask[i] / 255 : 0;
      const l = Math.hypot(m.matNormal[i * 4], m.matNormal[i * 4 + 1], m.matNormal[i * 4 + 2]) || 1;
      const dz = (m.matNormal[i * 4 + 2] / l) * (1 - t) + t;
      return (Math.hypot(m.matNormal[i * 4], m.matNormal[i * 4 + 1]) / l) * (1 - t) / Math.max(dz, 1e-3);
    };
    let steep = 0, against = 0, againstFlipped = 0;
    let inSum = 0, inN = 0, outSum = 0, outN = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        // Sobel on the macro height, y up (as normalFromHeight).
        const sx = (H(x + 1, y - 1) + 2 * H(x + 1, y) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x - 1, y) + H(x - 1, y + 1));
        const sr = (H(x - 1, y + 1) + 2 * H(x, y + 1) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x, y - 1) + H(x + 1, y - 1));
        const gx = sx / (8 * mpp), gy = -sr / (8 * mpp);
        const rx = ((R(x + 1, y - 1) + 2 * R(x + 1, y) + R(x + 1, y + 1)) - (R(x - 1, y - 1) + 2 * R(x - 1, y) + R(x - 1, y + 1))) / (8 * mpp);
        const ry = -((R(x - 1, y + 1) + 2 * R(x, y + 1) + R(x + 1, y + 1)) - (R(x - 1, y - 1) + 2 * R(x, y - 1) + R(x + 1, y - 1))) / (8 * mpp);
        const n = [0, 1, 2].map((c) => (m.normal[i * 4 + c] / 255) * 2 - 1);
        // R40/R41: only where the macro slope is steep and beats the material slope (height relief or detail normal).
        const matSlope = Math.max(Math.hypot(rx, ry), detailSlope(i));
        if (Math.hypot(gx, gy) > 0.2 && Math.hypot(gx, gy) > matSlope) {
          steep++;
          if (n[0] * -gx + n[1] * -gy < 0) against++;
          // A normal with inverted xy must fail on (almost) every counted pixel: the rule still discriminates.
          if (-n[0] * -gx + -n[1] * -gy < 0) againstFlipped++;
        }
        if (m.rectId[i] === 0) continue;
        // Angle between the final normal and the Sobel macro normal.
        const l = Math.hypot(gx, gy, 1);
        const dev = Math.acos(Math.min(1, (n[0] * -gx + n[1] * -gy + n[2]) / (l * Math.hypot(n[0], n[1], n[2]))));
        const b = m.border![i];
        if (b < -0.006) { inSum += dev; inN++; } else if (b >= 0.024 - 1e-6) { outSum += dev; outN++; }
      }
    }
    return { steep, against, againstFlipped, inMean: inSum / inN, inN, outMean: outSum / outN, outN };
  });
  expect(r.steep).toBeGreaterThan(1000);
  expect(r.against).toBe(0);
  expect(r.againstFlipped).toBeGreaterThan(0.95 * r.steep);
  expect(r.inN).toBeGreaterThan(1000);
  expect(r.outN).toBeGreaterThan(1000);
  expect(r.inMean).toBeLessThan(0.5 * r.outMean);
});

test('wear outputs: border clamped to ±4 · bandM and negative exactly on the loss; wearMask 0 outside it', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const m = await window.__t8!.compose({ wear: { intensity: 0.8 } });
    let badSign = 0, outOfRange = 0, maskOutside = 0, maskDeep = 0, deep = 0;
    for (let i = 0; i < m.w * m.h; i++) {
      if (m.rectId[i] === 0) continue;
      const b = m.border![i];
      const lost = m.loss[2 * i] > 0.5;
      if (lost !== b < 0) badSign++;
      if (Math.abs(b) > 4 * 0.006 + 1e-6) outOfRange++;
      if (!lost && m.wearMask![i] !== 0) maskOutside++;
      if (b < -0.006) {
        deep++;
        if (m.wearMask![i] < 250) maskDeep++;
      }
    }
    return { badSign, outOfRange, maskOutside, maskDeep, deep, sizes: [m.borderSize, m.wearMaskSize] };
  });
  expect(r.badSign).toBe(0);
  expect(r.outOfRange).toBe(0);
  expect(r.maskOutside).toBe(0);
  expect(r.deep).toBeGreaterThan(1000);
  expect(r.maskDeep).toBe(0);
});

test('R31: the groove floor is never worn and no break digs below it', async ({ page }, testInfo) => {
  const r = await page.evaluate(async () => {
    const out: Record<string, number>[] = [];
    // Deep breaks (depthM 2 cm > the 4 mm groove) so the groove-floor clamp is exercised.
    for (const wear of [{ intensity: 1 }, { intensity: 1, depthM: 0.02 }]) {
      const plain = await window.__t8!.compose({ wear: null });
      const m = await window.__t8!.compose({ wear });
      const grooveDepthM = window.__hs!.core.DEFAULT_GROOVE.depthM;
      let floorPx = 0, floorMarked = 0, floorLoss = 0, floorHeight = 0, floorMask = 0, belowFloor = 0, markerOutside = 0;
      for (let y = 0; y < m.h; y++) {
        for (let x = 0; x < m.w; x++) {
          const i = y * m.w + x;
          // Groove floor: outside the visible edge. The rect-id raster is already shrunk to the visible edge, so
          // these are mostly id 0; the lossR = -1 marker covers rect pixels the raster and the analytic edge disagree on.
          const onFloor = m.edgeM(x, y) < 0;
          if (onFloor) {
            floorPx++;
            if (m.floorMarker[i]) floorMarked++;
            if (m.loss[2 * i] > 0 || m.loss[2 * i + 1] > 0) floorLoss++;
            if (m.height[i] !== plain.height[i]) floorHeight++;
            if (m.wearMask![i] > 0) floorMask++;
          } else if (m.floorMarker[i]) {
            markerOutside++;
          }
          // On rect pixels h ≥ −grooveDepthM, unless the material itself already lies below the floor.
          if (m.rectId[i] !== 0 && m.height[i] < Math.min(plain.height[i], -grooveDepthM) - 1e-7) belowFloor++;
        }
      }
      out.push({ floorPx, floorMarked, floorLoss, floorHeight, floorMask, belowFloor, markerOutside });
    }
    return out;
  });
  for (const v of r) {
    // The rect-id raster already excludes the floor and applies the same pixel-centre test as the analytic edge, so the
    // marker only catches float-rounding disagreements; it cannot be triggered reliably, hence an annotation only.
    testInfo.annotations.push({ type: 'floorMarked', description: `${v.floorMarked} of ${v.floorPx} floor pixels` });
    expect(v.floorPx).toBeGreaterThan(1000);
    expect(v.markerOutside).toBe(0);
    expect(v.floorLoss).toBe(0);
    expect(v.floorHeight).toBe(0);
    expect(v.floorMask).toBe(0);
    expect(v.belowFloor).toBe(0);
  }
});

// ---------------------------------------------------------------------------
// Task 10: colour composite (substrate, edge tone), height AO, cavity dirt and runoff.
// ---------------------------------------------------------------------------

const BAND_M = 0.006;
const BEVEL_M = 0.003;

test('interior substrate with valMul 0.5 darkens the lost pixels against their intact neighbours', async ({ page }) => {
  const r = await page.evaluate(async ({ bandM, bevelM }) => {
    const { core } = window.__hs!;
    const m = await window.__t8!.compose({
      wear: { intensity: 0.8, substrate: { ...core.DEFAULT_WEAR.substrate, satMul: 1, valMul: 0.5, roughAdd: 0 } },
    });
    const value = (i: number) => Math.max(m.bytes.baseColor[4 * i], m.bytes.baseColor[4 * i + 1], m.bytes.baseColor[4 * i + 2]);
    let lostSum = 0, lostN = 0, nearSum = 0, nearN = 0;
    for (let y = 0; y < m.h; y++) {
      for (let x = 0; x < m.w; x++) {
        const i = y * m.w + x;
        if (m.rectId[i] === 0 || m.edgeM(x, y) < bevelM + m.mpp) continue;
        const b = m.border![i];
        if (m.wearMask![i] >= 250) { lostSum += value(i); lostN++; } else if (b > bandM && b < 3 * bandM) { nearSum += value(i); nearN++; }
      }
    }
    return { lost: lostSum / lostN, lostN, near: nearSum / nearN, nearN };
  }, { bandM: BAND_M, bevelM: BEVEL_M });
  expect(r.lostN).toBeGreaterThan(1000);
  expect(r.nearN).toBeGreaterThan(1000);
  expect(r.lost).toBeLessThan(0.75 * r.near);
});

test('a pure red second set shows red in the loss and leaves intact pixels as without wear', async ({ page }) => {
  const r = await page.evaluate(async ({ bandM, bevelM }) => {
    const { core } = window.__hs!;
    const plain = await window.__t8!.compose({ wear: null });
    const m = await window.__t8!.compose({
      substrate: 'red', wear: { intensity: 0.8, substrate: { ...core.DEFAULT_WEAR.substrate, source: 'secondSet' } },
    });
    const c = m.bytes.baseColor;
    let lostN = 0, notRed = 0, intactN = 0, changed = 0;
    for (let y = 0; y < m.h; y++) {
      for (let x = 0; x < m.w; x++) {
        const i = y * m.w + x;
        if (m.rectId[i] === 0) continue;
        if (m.wearMask![i] >= 250) {
          lostN++;
          if (!(c[4 * i] > c[4 * i + 1] + c[4 * i + 2])) notRed++;
        } else if (m.border![i] >= bandM && m.edgeM(x, y) > bevelM + m.mpp) {
          intactN++;
          for (let k = 0; k < 4; k++) if (c[4 * i + k] !== plain.bytes.baseColor[4 * i + k]) { changed++; break; }
        }
      }
    }
    return { lostN, notRed, intactN, changed };
  }, { bandM: BAND_M, bevelM: BEVEL_M });
  expect(r.lostN).toBeGreaterThan(1000);
  expect(r.notRed).toBe(0);
  expect(r.intactN).toBeGreaterThan(100000);
  expect(r.changed).toBe(0);
});

test('a 4 × 4 checker second set at tileSize 0.5 keeps its 0.125 m period in the loss, rotated rects included', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { core } = window.__hs!;
    const m = await window.__t8!.compose({
      substrate: 'checker', substrateTileM: 0.5, rotate: [false, true],
      wear: { intensity: 1, widthM: 0.2, pieceBias: 0, substrate: { ...core.DEFAULT_WEAR.substrate, source: 'secondSet' } },
    });
    const frac = (v: number) => v - Math.floor(v);
    // Margin from a cell boundary: one substrate texel (0.5 m / 256) for the bilinear blend plus one output pixel.
    const margin = 0.5 / 256 + m.mpp;
    const out = [0, 0].map(() => ({ n: 0, mismatch: 0 }));
    for (let y = 0; y < m.h; y++) {
      for (let x = 0; x < m.w; x++) {
        const i = y * m.w + x;
        const id = m.rectId[i];
        if (id === 0 || m.wearMask![i] < 250) continue;
        // Material metres, as atlasPxToMaterialM (core placement.ts).
        const rect = m.rects[id - 1];
        const px = (x + 0.5) / m.refScale, py = (y + 0.5) / m.refScale;
        let lx = (px - rect.x) / m.ppm, ly = (rect.y + rect.h - py) / m.ppm;
        if (m.rotate90[id - 1]) [lx, ly] = [ly, -lx];
        const mx = m.originM[id - 1][0] + lx, my = m.originM[id - 1][1] + ly;
        const nearLine = (v: number) => { const f = frac(v / 0.125); return Math.min(f, 1 - f) * 0.125 < margin; };
        if (nearLine(mx) || nearLine(my)) continue;
        const ix = Math.floor(frac(mx / 0.5) * 256), iy = Math.floor(frac(1 - my / 0.5) * 256);
        const expectRed = ((ix >> 6) + (iy >> 6)) % 2 === 0;
        const isRed = m.bytes.baseColor[4 * i] > m.bytes.baseColor[4 * i + 2];
        out[id - 1].n++;
        if (isRed !== expectRed) out[id - 1].mismatch++;
      }
    }
    return out;
  });
  for (const v of r) {
    expect(v.n).toBeGreaterThan(5000);
    expect(v.mismatch / v.n).toBeLessThan(0.005);
  }
});

test('height AO is lower on the groove floor than at the rect centre', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const m = await window.__t8!.compose({ material: 'flat', wear: null });
    const ao = (x: number, y: number) => m.bytes.ao[4 * (y * m.w + x)];
    // The groove between rects a and b is centred on x = 512 at 1024 px.
    return { groove: ao(511, 512), grooveId: m.rectId[512 * m.w + 511], centre: ao(256, 512) };
  });
  expect(r.grooveId).toBe(0);
  expect(r.centre).toBe(255);
  expect(r.groove).toBeLessThan(0.8 * r.centre);
});

test('runoff darkens a strip below the top edge, never the groove above it', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const dirt = { cavity: 0 };
    const clean = await window.__t8!.compose({ material: 'flat', wear: null, dirt: { ...dirt, runoff: 0 } });
    const m = await window.__t8!.compose({ material: 'flat', wear: null, dirt: { ...dirt, runoff: 1 } });
    const luma = (c: Uint8Array, i: number) => 0.2126 * c[4 * i] + 0.7152 * c[4 * i + 1] + 0.0722 * c[4 * i + 2];
    let topSum = 0, topN = 0, midSum = 0, midN = 0, grooveChanged = 0, grooveN = 0;
    for (let y = 0; y < m.h; y++) {
      for (let x = 0; x < m.w; x++) {
        const i = y * m.w + x;
        if (m.rectId[i] === 0) {
          grooveN++;
          for (let k = 0; k < 4; k++) if (m.bytes.baseColor[4 * i + k] !== clean.bytes.baseColor[4 * i + k]) { grooveChanged++; break; }
          continue;
        }
        // Metres below the visible top edge.
        const rect = m.rects[m.rectId[i] - 1];
        const dTop = ((y + 0.5) / m.refScale - (rect.y + m.halfGroovePx)) / m.ppm;
        if (dTop < 0.05) { topSum += luma(m.bytes.baseColor, i); topN++; }
        if (Math.abs(dTop - 1) < 0.025) { midSum += luma(m.bytes.baseColor, i); midN++; }
      }
    }
    // Row 0 is the groove above the top edge of both rects.
    const row0 = Array.from({ length: m.w }, (_, x) => m.rectId[x]).every((id) => id === 0);
    return { top: topSum / topN, topN, mid: midSum / midN, midN, grooveChanged, grooveN, row0 };
  });
  expect(r.topN).toBeGreaterThan(1000);
  expect(r.midN).toBeGreaterThan(1000);
  expect(r.top).toBeLessThan(r.mid - 5);
  expect(r.row0).toBe(true);
  expect(r.grooveN).toBeGreaterThan(1000);
  expect(r.grooveChanged).toBe(0);
});

test('runoff also starts below each loss and never appears above its origin', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const L = 0.4;
    const wear = { intensity: 1, widthM: 0.2, pieceBias: 0 };
    const clean = await window.__t8!.compose({ material: 'flat', wear, dirt: { cavity: 0, runoff: 0 } });
    const m = await window.__t8!.compose({ material: 'flat', wear, dirt: { cavity: 0, runoff: 1, runoffLengthM: L } });
    let near = 0, nearChanged = 0, far = 0, farChanged = 0;
    for (let x = 0; x < m.w; x++) {
      let id = 0;
      // Row of the latest lost pixel above in this column and rect, or -1.
      let lastLoss = -1;
      for (let y = 0; y < m.h; y++) {
        const i = y * m.w + x;
        if (m.rectId[i] !== id) { id = m.rectId[i]; lastLoss = -1; }
        if (id === 0) continue;
        if (m.loss[2 * i] > 0.5) lastLoss = y;
        const rect = m.rects[id - 1];
        const dTop = ((y + 0.5) / m.refScale - (rect.y + m.halfGroovePx)) / m.ppm;
        // Beyond the reach of the top-edge runoff only the losses can tint.
        if (dTop < L + m.mpp) continue;
        let changed = false;
        for (let k = 0; k < 4; k++) if (m.bytes.baseColor[4 * i + k] !== clean.bytes.baseColor[4 * i + k]) changed = true;
        const dLoss = lastLoss < 0 ? Infinity : (y - lastLoss) * m.mpp;
        if (dLoss < 0.5 * L) { near++; if (changed) nearChanged++; } else if (dLoss > L + m.mpp) { far++; if (changed) farChanged++; }
      }
    }
    return { near, nearChanged, far, farChanged };
  });
  // Within half the reach of a loss above, the streak tints almost every pixel; beyond the reach (or above every loss
  // of the column) nothing changes.
  expect(r.near).toBeGreaterThan(1000);
  expect(r.nearChanged).toBeGreaterThan(0.9 * r.near);
  expect(r.far).toBeGreaterThan(1000);
  expect(r.farChanged).toBe(0);
});

test('edgeOnly reveals no substrate (wearMask 0) and polishes the edge: lower roughness than the centre', async ({ page }) => {
  const r = await page.evaluate(async ({ bevelM }) => {
    // At 2048 px (0.98 mm) the 3 mm bevel spans three pixels.
    const m = await window.__t8!.compose({ material: 'flat', resolutionPx: 2048, wear: { family: 'edgeOnly' } });
    let edgeSum = 0, edgeN = 0, centreSum = 0, centreN = 0, edgeValue = 0, centreValue = 0;
    const value = (i: number) => Math.max(m.bytes.baseColor[4 * i], m.bytes.baseColor[4 * i + 1], m.bytes.baseColor[4 * i + 2]);
    for (let y = 0; y < m.h; y++) {
      for (let x = 0; x < m.w; x++) {
        const i = y * m.w + x;
        const e = m.edgeM(x, y);
        if (m.rectId[i] === 0 || e < 0) continue;
        if (e < bevelM) {
          edgeSum += m.bytes.roughness[4 * i]; edgeValue += value(i); edgeN++;
        } else if (e > 0.1) {
          centreSum += m.bytes.roughness[4 * i]; centreValue += value(i); centreN++;
        }
      }
    }
    return {
      maskMax: m.wearMask!.reduce((a, v) => Math.max(a, v), 0), maskSize: m.wearMaskSize,
      edge: edgeSum / edgeN, edgeN, centre: centreSum / centreN,
      edgeValue: edgeValue / edgeN, centreValue: centreValue / centreN,
    };
  }, { bevelM: BEVEL_M });
  expect(r.maskSize).toEqual([2048, 2048]);
  expect(r.maskMax).toBe(0);
  expect(r.edgeN).toBeGreaterThan(1000);
  expect(r.edge).toBeLessThan(r.centre - 5);
  // The HSV value rises towards 1 on the edge.
  expect(r.edgeValue).toBeGreaterThan(r.centreValue + 5);
});

test('interior substrate hueShift 180 turns the hue of the lost pixels half a circle', async ({ page }) => {
  const r = await page.evaluate(async ({ bevelM }) => {
    const { core } = window.__hs!;
    const plain = await window.__t8!.compose({ colour: true, wear: null });
    const m = await window.__t8!.compose({
      colour: true,
      wear: { intensity: 0.8, substrate: { ...core.DEFAULT_WEAR.substrate, hueShift: 180, satMul: 1, valMul: 1, roughAdd: 0 } },
    });
    const hsv = (c: Uint8Array, i: number) => {
      const [r, g, b] = [c[4 * i], c[4 * i + 1], c[4 * i + 2]].map((v) => v / 255);
      const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
      let h = 0;
      if (d > 0) h = mx === r ? (g - b) / d : mx === g ? 2 + (b - r) / d : 4 + (r - g) / d;
      return { h: (((h / 6) % 1) + 1) % 1, s: mx > 0 ? d / mx : 0 };
    };
    let n = 0, errSum = 0, errMax = 0;
    for (let y = 0; y < m.h; y++) {
      for (let x = 0; x < m.w; x++) {
        const i = y * m.w + x;
        if (m.rectId[i] === 0 || m.wearMask![i] < 250 || m.edgeM(x, y) < bevelM + m.mpp) continue;
        const before = hsv(plain.bytes.baseColor, i);
        // Hue is ill-defined on near-grey pixels (the light joints).
        if (before.s < 0.3) continue;
        const after = hsv(m.bytes.baseColor, i);
        const d = (((after.h - before.h - 0.5) % 1) + 1) % 1;
        const err = Math.min(d, 1 - d);
        n++;
        errSum += err;
        errMax = Math.max(errMax, err);
      }
    }
    return { n, mean: errSum / n, max: errMax };
  }, { bevelM: BEVEL_M });
  expect(r.n).toBeGreaterThan(1000);
  expect(r.mean).toBeLessThan(0.02);
  expect(r.max).toBeLessThan(0.1);
});

test('height AO: material joints are darker than brick faces (no AO map)', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const m = await window.__t8!.compose({ wear: null });
    let jSum = 0, jN = 0, fSum = 0, fN = 0;
    for (let y = 0; y < m.h; y++) {
      for (let x = 0; x < m.w; x++) {
        const i = y * m.w + x;
        // Away from the groove, so only the material relief occludes.
        if (m.rectId[i] === 0 || m.edgeM(x, y) < 0.07) continue;
        if (m.jointDistM[i] < 0.002) { jSum += m.bytes.ao[4 * i]; jN++; } else if (m.jointDistM[i] > 0.04) { fSum += m.bytes.ao[4 * i]; fN++; }
      }
    }
    return { joint: jSum / jN, jN, face: fSum / fN, fN };
  });
  expect(r.jN).toBeGreaterThan(1000);
  expect(r.fN).toBeGreaterThan(1000);
  expect(r.joint).toBeLessThan(r.face - 20);
});

test('height AO: the loss is more occluded than its intact neighbours', async ({ page }) => {
  const r = await page.evaluate(async ({ bandM, bevelM }) => {
    const m = await window.__t8!.compose({ material: 'flat', wear: { intensity: 0.8, depthM: 0.006 } });
    let lostSum = 0, lostN = 0, nearSum = 0, nearN = 0;
    for (let y = 0; y < m.h; y++) {
      for (let x = 0; x < m.w; x++) {
        const i = y * m.w + x;
        if (m.rectId[i] === 0 || m.edgeM(x, y) < bevelM + m.mpp) continue;
        const b = m.border![i];
        if (m.wearMask![i] >= 250) { lostSum += m.bytes.ao[4 * i]; lostN++; } else if (b > bandM && b < 3 * bandM) { nearSum += m.bytes.ao[4 * i]; nearN++; }
      }
    }
    return { lost: lostSum / lostN, lostN, near: nearSum / nearN, nearN };
  }, { bandM: BAND_M, bevelM: BEVEL_M });
  expect(r.lostN).toBeGreaterThan(1000);
  expect(r.nearN).toBeGreaterThan(1000);
  expect(r.lost).toBeLessThan(r.near - 5);
});

test('height AO on the groove floor matches at 1024 and 2048 (metre radii)', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const lo = await window.__t8!.compose({ material: 'flat', wear: null, resolutionPx: 1024 });
    const hi = await window.__t8!.compose({ material: 'flat', wear: null, resolutionPx: 2048 });
    // Pixel centres half a pixel left of the groove centre line (x = 1 m), at mid height.
    return {
      lo: lo.bytes.ao[4 * (512 * lo.w + 511)], loId: lo.rectId[512 * lo.w + 511],
      hi: hi.bytes.ao[4 * (1024 * hi.w + 1023)], hiId: hi.rectId[1024 * hi.w + 1023],
    };
  });
  expect(r.loId).toBe(0);
  expect(r.hiId).toBe(0);
  expect(r.lo).toBeLessThan(230);
  expect(Math.abs(r.lo - r.hi)).toBeLessThanOrEqual(10);
});

test('R33: with a real AO map the material relief is not occluded twice', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const scan = async (aoMap: boolean) => {
      const m = await window.__t8!.compose({ wear: null, aoMap });
      let n = 0, sum = 0, offMap = 0;
      for (let y = 0; y < m.h; y++) {
        for (let x = 0; x < m.w; x++) {
          const i = y * m.w + x;
          if (m.rectId[i] === 0 || m.edgeM(x, y) < 0.07 || m.jointDistM[i] >= 0.002) continue;
          n++;
          sum += m.bytes.ao[4 * i];
          // The AO map is the same image as the albedo, sampled at the same uv: baked AO = baseColor R.
          if (Math.abs(m.bytes.ao[4 * i] - m.bytes.baseColor[4 * i]) > 1) offMap++;
        }
      }
      return { n, mean: sum / n, offMap };
    };
    return { withMap: await scan(true), without: await scan(false) };
  });
  // Without a map the joints get relief AO; with one, far from the groove the AO is the baked map alone.
  expect(r.without.n).toBeGreaterThan(1000);
  expect(r.without.mean).toBeLessThan(235);
  expect(r.withMap.n).toBeGreaterThan(1000);
  expect(r.withMap.offMap).toBe(0);
});

test('8192 robustness: row bands and split submits leave every map byte-identical', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const fnv = (d: Uint8Array) => {
      let h = 0x811c9dc5;
      for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 0x01000193) >>> 0;
      return h;
    };
    const f8 = (a: ArrayLike<number> | null) => (a ? fnv(new Uint8Array(new Float32Array(a).buffer)) : 0);
    const hashes = async (opts: Parameters<NonNullable<typeof window.__t8>['compose']>[0]) => {
      const p = await window.__t8!.compose(opts);
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(p.bytes)) out[k] = fnv(v);
      out.macroHeight = f8(p.macroHeight);
      out.border = f8(p.border);
      out.wearMask = p.wearMask ? fnv(p.wearMask) : 0;
      return out;
    };
    const cases = {
      wearDirt: { resolutionPx: 2048, colour: true, normalMap: true, dirt: { runoff: 1, cavity: 1 } },
      noWear: { resolutionPx: 2048, wear: null, dirt: { runoff: 1 } },
      maskSubstrate: { resolutionPx: 2048, mask: 'leftBlack' as const, substrate: 'checker' as const, aoMap: true, dirt: { runoff: 0.5 } },
    };
    const out: Record<string, { whole: Record<string, number>; banded: Record<string, number> }> = {};
    for (const [name, opts] of Object.entries(cases)) {
      // 4096 rows per band: one band, as one dispatch; 64: 32 bands of the colour composite and of every JFA step.
      out[name] = { whole: await hashes({ ...opts, bandRows: 4096 }), banded: await hashes({ ...opts, bandRows: 64 }) };
    }
    return out;
  });
  // HS_PRINT_HASHES=1 prints them, so a refactor can be checked against the hashes of the previous build on the GPU.
  if (process.env.HS_PRINT_HASHES === '1') console.log(JSON.stringify(r));
  for (const v of Object.values(r)) expect(v.banded).toEqual(v.whole);
});

test('a broken pipeline fails the compose that uses it, never a concurrent one (R39)', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { engine } = window.__hs!;
    // A fresh device: nothing is cached on it yet.
    const ctx = await engine.initGpu();
    const { device } = ctx;
    const bad = () => device.createComputePipeline({
      layout: 'auto', compute: { module: device.createShaderModule({ code: 'fn main( {' }), entryPoint: 'main' },
    });
    // The colour composite of a material with an AO map and no runoff (CHUNK 8, LOOKBACK 0, AO_ON_MACRO 1).
    const key = 'colorComposite:8:0:1';
    let release!: () => void;
    const held = new Promise<void>((res) => { release = res; });
    const settle = (p: Promise<unknown>) => p.then(
      () => ({ ok: true, name: '', message: '' }),
      (e: Error) => ({ ok: false, name: e.name, message: e.message }),
    );
    // B injects the broken pipeline and composes first, in the same task; A (the AO map compose that uses the key)
    // starts right after. With one shared pending list, B would take A's error and A would pass.
    const a = settle(window.__t8!.compose({ ctx, aoMap: true, beforeCompose: () => held }));
    const b = settle(window.__t8!.compose({
      ctx,
      beforeCompose: () => {
        engine.cached(device, key, bad);
        release();
      },
    }));
    const out = { a: await a, b: await b, key };
    device.destroy();
    return out;
  });
  expect(r.b).toEqual({ ok: true, name: '', message: '' });
  expect(r.a.ok).toBe(false);
  expect(r.a.name).toBe('PipelineValidationError');
  expect(r.a.message).toContain(`"${r.key}"`);
});

test('a WGSL error in a cached pipeline surfaces through checkPipelines, once, and is not cached', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { engine } = window.__hs!;
    const { device } = await engine.initGpu();
    const bad = () => device.createComputePipeline({
      layout: 'auto', compute: { module: device.createShaderModule({ code: 'fn main( {' }), entryPoint: 'main' },
    });
    const first = engine.cached(device, 'broken', bad);
    const err = await engine.checkPipelines(device).then(() => null, (e: Error) => ({ name: e.name, message: e.message }));
    const again = await engine.checkPipelines(device).then(() => 'ok', () => 'threw');
    const second = engine.cached(device, 'broken', bad);
    const reported = await engine.checkPipelines(device).then(() => false, () => true);
    const good = () => device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: '@compute @workgroup_size(1) fn main() {}' }), entryPoint: 'main' },
    });
    const g1 = engine.cached(device, 'fine', good);
    await engine.checkPipelines(device);
    const g2 = engine.cached(device, 'fine', good);
    device.destroy();
    return { err, again, recreated: first !== second, reported, sameGood: g1 === g2 };
  });
  expect(r.err?.name).toBe('PipelineValidationError');
  expect(r.err?.message).toContain('"broken"');
  // Shown to the user as is: it leads with a Spanish sentence.
  expect(r.err?.message).toMatch(/^Error interno de un shader \("broken"\)/);
  expect(r).toMatchObject({ again: 'ok', recreated: true, reported: true, sameGood: true });
});

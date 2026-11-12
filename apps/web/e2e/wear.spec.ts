import { test, expect } from '@playwright/test';
import type { WearParams } from '@hotspotter/core';

// ---------------------------------------------------------------------------
// Wear loss pass (Task 8).
// 'pair' layout: two 1 × 2 m rects side by side (512 × 512 reference px, 2 m wide, 256 px/m), default groove.
// 'trim' layout: one 4 × 0.06 m rect (2000 × 100 reference px, 4 m wide, 500 px/m).
// Brick material: syntheticBrick 256 px, tile 1 × 1 m (bricks 0.25 × 0.125 m, joints 1.56 cm), uploaded as
// height + albedo and analysed on the CPU (analyzeStructure).
// ---------------------------------------------------------------------------

interface ComposeOpts {
  material?: 'brick' | 'albedo';
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
    window.__t8 = {
      async compose({
        material = 'brick', structure, layout: kind = 'pair', resolutionPx = 1024, wear = {}, mask, grainAxis = null, rotate,
        normalMap = false, colour = false,
      }) {
        const ctx = await (ctxP ??= engine.initGpu());
        const groove = core.DEFAULT_GROOVE;
        const structureFrom = structure ?? (material === 'brick' ? 'height' : false);
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
        const images: Partial<Record<'baseColor' | 'height' | 'normal', ImageBitmap>> = { baseColor: albedoBmp };
        if (material === 'brick') images.height = bmp;
        if (normalMap) images.normal = await toBitmap(normalRgba, 64, 64);
        const gpuMaterial = engine.uploadMaterial(ctx, { settings, images });
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
        const maps = await engine.composeAtlas(ctx, {
          layout, material: gpuMaterial, placements, resolutionPx, structure: gpuStructure,
          wear: wearParams, mask: maskTex, grainAxis,
        });
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
        gpuStructure?.destroy();
        maskTex?.destroy();
        return {
          w, h, lossSize, loss, rectId, jointDistM, rects, refScale, ppm, halfGroovePx, grooveWidthM: groove.widthM,
          height: new Float32Array(heightBytes), macroHeight, normal: new Uint8Array(normalBytes), border, wearMask,
          borderSize, wearMaskSize, bytes, heightRangeM: maps.heightRangeM, floorMarker,
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
    const d = { cavity: 0.5, runoff: 0.25, runoffLengthM: 0.625, tint: [0.25, 0.5, 0.75] as [number, number, number] };
    const buf = engine.packWear({ ...w, family: 'dent' }, d, core.WEAR_FAMILIES.chipping, { hasPieces: true, grainAxis: 'y', maskBound: true });
    const dv = new DataView(buf);
    const f = (o: number) => dv.getFloat32(o, true);
    const u = (o: number) => dv.getUint32(o, true);
    const layout = {
      bytes: buf.byteLength, enabled: u(0), intensity: f(4), widthM: f(8), minEdgeM: f(12), sizeM: f(16),
      depthM: f(20), bandM: f(24), microM: f(28), pieceBias: f(32), edgeTone: f(36), maskStrength: f(40),
      maskEnabled: u(44), maskInvert: u(48), hasPieces: u(52), grainAxis: u(56), cellMix: f(60), anisotropy: f(64),
      steps: u(68), loses: u(72), polish: f(76), cavity: f(80), runoff: f(84), runoffLengthM: f(88),
      tint: [f(92), f(96), f(100)], family: u(104),
    };
    const bad = engine.packWear(
      { ...core.DEFAULT_WEAR, intensity: Number.NaN, widthM: -1, sizeM: Infinity, pieceBias: 3, mask: { enabled: false, strength: 2, invert: false } },
      core.DEFAULT_DIRT, core.WEAR_FAMILIES.brittle, { hasPieces: false, grainAxis: null, maskBound: false },
    );
    const bv = new DataView(bad);
    const sanitized = {
      intensity: bv.getFloat32(4, true), widthM: bv.getFloat32(8, true), sizeM: bv.getFloat32(16, true),
      pieceBias: bv.getFloat32(32, true), maskStrength: bv.getFloat32(40, true), maskEnabled: bv.getUint32(44, true),
    };
    return { layout, sanitized };
  });
  expect(r.layout).toEqual({
    bytes: 128, enabled: 1, intensity: 0.25, widthM: expect.closeTo(0.05, 7), minEdgeM: expect.closeTo(0.003, 7),
    sizeM: expect.closeTo(0.02, 7), depthM: expect.closeTo(0.007, 7), bandM: expect.closeTo(0.008, 7),
    microM: expect.closeTo(0.001, 7), pieceBias: 0.5, edgeTone: 0.375, maskStrength: 0.75, maskEnabled: 1,
    maskInvert: 1, hasPieces: 1, grainAxis: 2, cellMix: expect.closeTo(0.6, 6), anisotropy: 1, steps: 2, loses: 1,
    polish: expect.closeTo(0.1, 6), cavity: 0.5, runoff: 0.25, runoffLengthM: 0.625,
    tint: [0.25, 0.5, 0.75], family: 4,
  });
  expect(r.sanitized).toEqual({
    intensity: 0.5, widthM: 0, sizeM: expect.closeTo(0.03, 7), pieceBias: 1, maskStrength: 1, maskEnabled: 0,
  });
});

// ---------------------------------------------------------------------------
// Task 9: border distance and height composite.
// ---------------------------------------------------------------------------

test('without wear the compose matches a wear compose that loses nothing (normal within 1 LSB)', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const out: Record<string, unknown> = {};
    for (const normalMap of [false, true]) {
      // widthM 0 disables edge wear entirely (R30): the wear passes run but change nothing.
      const plain = await window.__t8!.compose({ wear: null, normalMap });
      const zero = await window.__t8!.compose({ wear: { widthM: 0 }, normalMap });
      const differing: string[] = [];
      for (const k of ['baseColor', 'height', 'roughness', 'metallic', 'ao', 'rectId', 'pieceId', 'jointDistM'] as const) {
        const a = plain.bytes[k], b = zero.bytes[k];
        if (a.length !== b.length || a.some((v, i) => v !== b[i])) differing.push(k);
      }
      let normalMaxLsb = 0;
      for (let i = 0; i < plain.bytes.normal.length; i++) {
        normalMaxLsb = Math.max(normalMaxLsb, Math.abs(plain.bytes.normal[i] - zero.bytes.normal[i]));
      }
      out[normalMap ? 'normalMap' : 'heightOnly'] = {
        differing, normalMaxLsb, sameRange: plain.heightRangeM.every((v, i) => v === zero.heightRangeM[i]),
        border: plain.borderSize, wearMask: plain.wearMaskSize, zeroBorder: zero.borderSize,
      };
    }
    return out;
  });
  for (const k of ['heightOnly', 'normalMap']) {
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
    const H = (x: number, y: number) => m.macroHeight[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
    let steep = 0, against = 0;
    let inSum = 0, inN = 0, outSum = 0, outN = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        // Sobel on the macro height, y up (as normalFromHeight).
        const sx = (H(x + 1, y - 1) + 2 * H(x + 1, y) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x - 1, y) + H(x - 1, y + 1));
        const sr = (H(x - 1, y + 1) + 2 * H(x, y + 1) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x, y - 1) + H(x + 1, y - 1));
        const gx = sx / (8 * mpp), gy = -sr / (8 * mpp);
        const n = [0, 1, 2].map((c) => (m.normal[i * 4 + c] / 255) * 2 - 1);
        if (Math.hypot(gx, gy) > 0.2) {
          steep++;
          if (n[0] * -gx + n[1] * -gy < 0) against++;
        }
        if (m.rectId[i] === 0) continue;
        // Angle between the final normal and the Sobel macro normal.
        const l = Math.hypot(gx, gy, 1);
        const dev = Math.acos(Math.min(1, (n[0] * -gx + n[1] * -gy + n[2]) / (l * Math.hypot(n[0], n[1], n[2]))));
        const b = m.border![i];
        if (b < -0.006) { inSum += dev; inN++; } else if (b >= 0.024 - 1e-6) { outSum += dev; outN++; }
      }
    }
    return { steep, against, inMean: inSum / inN, inN, outMean: outSum / outN, outN };
  });
  expect(r.steep).toBeGreaterThan(1000);
  expect(r.against).toBe(0);
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

test('R31: the groove floor is never worn and no break digs below it', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const out: Record<string, number>[] = [];
    // Deep breaks (depthM 2 cm > the 4 mm groove) so the groove-floor clamp is exercised.
    for (const wear of [{ intensity: 1 }, { intensity: 1, depthM: 0.02 }]) {
      const plain = await window.__t8!.compose({ wear: null });
      const m = await window.__t8!.compose({ wear });
      const grooveDepthM = 0.004;
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
    expect(v.floorPx).toBeGreaterThan(1000);
    expect(v.markerOutside).toBe(0);
    expect(v.floorLoss).toBe(0);
    expect(v.floorHeight).toBe(0);
    expect(v.floorMask).toBe(0);
    expect(v.belowFloor).toBe(0);
  }
});

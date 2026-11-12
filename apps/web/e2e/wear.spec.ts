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
  /** Analyse and upload the structure (brick only). */
  structure?: boolean;
  layout?: 'pair' | 'trim';
  resolutionPx?: number;
  /** Merged over DEFAULT_WEAR; null composes without wear. */
  wear?: Partial<WearParams> | null;
  mask?: 'black' | 'white';
}

interface WearProbe {
  w: number;
  h: number;
  /** rg32float texels: [r, g] per pixel. */
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
}

declare global {
  interface Window {
    __t8?: { compose(opts: ComposeOpts): Promise<WearProbe> };
  }
}

test.describe.configure({ timeout: 90_000 });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__hs);
  await page.evaluate(() => {
    const { core, engine } = window.__hs!;
    let ctxP: Promise<import('@hotspotter/engine').GpuContext> | null = null;
    const brick = core.syntheticBrick({ size: 256, courseH: 32, brickW: 64, joint: 4, jointH: 0.2, brickH: 0.8 });
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
    window.__t8 = {
      async compose({ material = 'brick', structure = true, layout: kind = 'pair', resolutionPx = 1024, wear = {}, mask }) {
        const ctx = await (ctxP ??= engine.initGpu());
        const groove = core.DEFAULT_GROOVE;
        const layout = kind === 'pair'
          ? {
            version: 1 as const, widthPx: 512, heightPx: 512, worldWidthM: 2, groove,
            rects: [
              core.makeRect({ id: 'a', x: 0, y: 0, w: 256, h: 512 }),
              core.makeRect({ id: 'b', x: 256, y: 0, w: 256, h: 512 }),
            ],
          }
          : {
            version: 1 as const, widthPx: 2000, heightPx: 100, worldWidthM: 4, groove,
            rects: [core.makeRect({ id: 't', x: 0, y: 35, w: 2000, h: 30 })],
          };
        const tileSizeM: [number, number] = [1, 1];
        const settings = {
          name: 't8', files: {}, normalConvention: 'gl' as const, roughnessIsGloss: false, tileSizeM,
          heightScaleM: 0.02, period: core.CONTINUOUS, allowRotation: false,
          orientation: { baseRotation: 0 as const, rule: 'fixed' as const },
        };
        const bmp = await toBitmap(brick.rgba, 256, 256);
        const gpuMaterial = engine.uploadMaterial(ctx, {
          settings,
          images: material === 'brick' ? { baseColor: bmp, height: bmp } : { baseColor: bmp },
        });
        const gpuStructure = material === 'brick' && structure
          ? engine.uploadStructure(ctx, core.analyzeStructure(brick.gray, tileSizeM))
          : undefined;
        const placements = core.placeMaterial(layout, core.CONTINUOUS, {
          variation: 0, seed: 1, materialAllowsRotation: false, tileSizeM, orientation: settings.orientation,
        });
        const maskTex = mask ? engine.createConstTexture(ctx, mask === 'black' ? [0, 0, 0, 255] : [255, 255, 255, 255]) : undefined;
        const wearParams = wear === null ? undefined : {
          ...core.DEFAULT_WEAR, ...wear,
          mask: { ...core.DEFAULT_WEAR.mask, enabled: !!mask, ...(wear.mask ?? {}) },
        };
        const maps = await engine.composeAtlas(ctx, {
          layout, material: gpuMaterial, placements, resolutionPx, structure: gpuStructure,
          wear: wearParams, mask: maskTex, grainAxis: null,
        });
        const loss = new Float32Array(await readTexels(ctx, maps.loss, 8));
        const rectId = new Uint32Array(await readTexels(ctx, maps.rectId, 4));
        const jointDistM = new Float32Array(await readTexels(ctx, maps.jointDistM, 4));
        const w = maps.loss.width;
        const h = maps.loss.height;
        const refScale = resolutionPx / layout.widthPx;
        const ppm = layout.widthPx / layout.worldWidthM;
        const halfGroovePx = 0.5 * groove.widthM * ppm;
        const rects = layout.rects.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h }));
        gpuStructure?.destroy();
        maskTex?.destroy();
        return {
          w, h, loss, rectId, jointDistM, rects, refScale, ppm, halfGroovePx,
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
    return { lost: m.loss.reduce((n, v) => n + (v !== 0 ? 1 : 0), 0), size: [m.w, m.h] };
  });
  expect(r.size).toEqual([1024, 1024]);
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

test('Review Focus 5: the loss fraction at 1024 and 2048 differs by less than 0.03', async ({ page }) => {
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
    return {
      low: frac(await window.__t8!.compose({ resolutionPx: 1024 })),
      high: frac(await window.__t8!.compose({ resolutionPx: 2048 })),
    };
  });
  expect(r.low).toBeGreaterThan(0);
  expect(Math.abs(r.low - r.high)).toBeLessThan(0.03);
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

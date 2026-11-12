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
        const bmp = await toBitmap(brick.rgba, 256, 256);
        const gpuMaterial = engine.uploadMaterial(ctx, {
          settings,
          images: material === 'brick' ? { baseColor: bmp, height: bmp } : { baseColor: bmp },
        });
        const gpuStructure = structureFrom === 'height'
          ? engine.uploadStructure(ctx, core.analyzeStructure(brick.gray, tileSizeM))
          : structureFrom === 'invertedLuma'
            ? engine.uploadStructure(ctx, core.analyzeStructure(core.toGray(brick.rgba, 256, 256, 'invertedLuma'), tileSizeM))
            : undefined;
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
        for (let i = 0; i < packed.length; i++) {
          loss[2 * i] = halfToFloat(packed[i] & 0xffff);
          loss[2 * i + 1] = halfToFloat(packed[i] >>> 16);
        }
        const rectId = new Uint32Array(await readTexels(ctx, maps.rectId, 4));
        const jointDistM = new Float32Array(await readTexels(ctx, maps.jointDistM, 4));
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
        for (const t of Object.values(gpuMaterial.textures)) t.destroy();
        gpuStructure?.destroy();
        maskTex?.destroy();
        return {
          w, h, lossSize, loss, rectId, jointDistM, rects, refScale, ppm, halfGroovePx, grooveWidthM: groove.widthM,
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
    const m = await window.__t8!.compose({ material: 'albedo', structure: 'invertedLuma', wear: { intensity: 0.8 } });
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

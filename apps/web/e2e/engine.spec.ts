import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__hs);
});

test('initGpu resolves with an adapter description', async ({ page }) => {
  const ok = await page.evaluate(async () => {
    const ctx = await window.__hs!.engine.initGpu();
    return typeof ctx.adapterInfo === 'string' && !!ctx.device;
  });
  expect(ok).toBe(true);
});

test('uploadRgba8 then readbackRgba8 round-trips a 4x4 bitmap', async ({ page }) => {
  const { expected, got, w, h } = await page.evaluate(async () => {
    const { engine } = window.__hs!;
    const ctx = await engine.initGpu();
    const bytes = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 0; i < 16; i++) {
      bytes.set([i * 16, 255 - i * 16, (i * 37) % 256, 255], i * 4);
    }
    const bmp = await createImageBitmap(new ImageData(bytes, 4, 4), {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });
    const tex = engine.uploadRgba8(ctx, bmp, { srgb: false });
    const r = await engine.readbackRgba8(ctx, tex);
    return { expected: Array.from(bytes), got: Array.from(r.data), w: r.width, h: r.height };
  });
  expect([w, h]).toEqual([4, 4]);
  expect(got).toEqual(expected);
});

test('createConstTexture returns the constant color', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { engine } = window.__hs!;
    const ctx = await engine.initGpu();
    const out = await engine.readbackRgba8(ctx, engine.createConstTexture(ctx, [10, 20, 30, 255]));
    return { w: out.width, h: out.height, data: Array.from(out.data) };
  });
  expect(r).toEqual({ w: 1, h: 1, data: [10, 20, 30, 255] });
});

// ---------------------------------------------------------------------------
// Atlas composition (Task 11)
// Layout: two 256x512 rects side by side in a 512x512 atlas, 1 m wide
// (512 px/m), groove 0.02 m wide. Albedo: 128x128 checkerboard of 8x8 cells
// (16 px each), tileSizeM [1, 1], so one cell = 0.125 m = 64 atlas px.
// Cell colour: R = checker (0/255), G = column * 32, B = row-from-bottom * 32.
// ---------------------------------------------------------------------------

interface ComposeProbe {
  w: number;
  h: number;
  baseColor: Uint8Array;
  normal: Uint8Array;
  roughness: Uint8Array;
  heightRgba8: Uint8Array;
  height: Float32Array;
  rectId: Uint32Array;
  heightRangeM: [number, number];
  albedoBottomLeft: number[];
}

declare global {
  interface Window {
    __t11?: {
      compose(opts: { albedoOnly?: boolean; normal?: 'gl' | 'dx' }): Promise<ComposeProbe>;
    };
  }
}

const DEPTH_M = 0.004;

test.describe('composeAtlas', () => {
  test.beforeEach(async ({ page }) => {
    await page.evaluate((depthM) => {
      const bitmap = (w: number, h: number, f: (x: number, y: number) => number[]) => {
        const bytes = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) bytes.set(f(x, y), (y * w + x) * 4);
        return createImageBitmap(new ImageData(bytes, w, h), {
          colorSpaceConversion: 'none',
          premultiplyAlpha: 'none',
        });
      };
      // Image row 0 is the top; cy counts cells from the bottom (material y up).
      const checker = (x: number, y: number) => {
        const cx = Math.floor(x / 16);
        const cy = 7 - Math.floor(y / 16);
        return [(cx + cy) % 2 ? 255 : 0, cx * 32, cy * 32, 255];
      };
      window.__t11 = {
        async compose({ albedoOnly = true, normal = 'gl' }) {
          const { core, engine } = window.__hs!;
          const ctx = await engine.initGpu();
          const period = { x: 0.125, y: 0.125, phaseX: 0, phaseY: 0, cutAllowedX: false, cutAllowedY: false };
          const layout = {
            version: 1 as const,
            widthPx: 512,
            heightPx: 512,
            worldWidthM: 1,
            rects: [
              core.makeRect({ id: 'a', x: 0, y: 0, w: 256, h: 512 }),
              core.makeRect({ id: 'b', x: 256, y: 0, w: 256, h: 512 }),
            ],
            groove: { widthM: 0.02, depthM, profile: 'bevel' as const },
          };
          const images: Partial<Record<'baseColor' | 'normal', ImageBitmap>> = {
            baseColor: await bitmap(128, 128, checker),
          };
          // Unit-length normal (0, 0.6, 0.8), encoded.
          if (!albedoOnly) images.normal = await bitmap(16, 16, () => [128, 204, 230, 255]);
          const material = engine.uploadMaterial(ctx, {
            settings: {
              name: 't11',
              files: {},
              normalConvention: normal,
              roughnessIsGloss: false,
              tileSizeM: [1, 1],
              heightScaleM: 0.02,
              period,
              allowRotation: false,
            },
            images,
          });
          const placements = core.placeMaterial(layout, period, {
            variation: 0, seed: 1, materialAllowsRotation: false, tileSizeM: [1, 1],
          });
          const maps = await engine.composeAtlas(ctx, { layout, material, placements, resolutionPx: 512 });
          const rb = async (t: GPUTexture) => (await engine.readbackRgba8(ctx, t)).data;
          const heightBytes = await rb(maps.height);
          const idBytes = await rb(maps.rectId);
          return {
            w: maps.baseColor.width,
            h: maps.baseColor.height,
            baseColor: await rb(maps.baseColor),
            normal: await rb(maps.normal),
            roughness: await rb(maps.roughness),
            heightRgba8: await rb(engine.heightToRgba8(ctx, maps)),
            height: new Float32Array(heightBytes.buffer, heightBytes.byteOffset, heightBytes.byteLength / 4),
            rectId: new Uint32Array(idBytes.buffer, idBytes.byteOffset, idBytes.byteLength / 4),
            heightRangeM: maps.heightRangeM,
            // Material origin = the image's bottom-left texel.
            albedoBottomLeft: checker(0, 127),
          };
        },
      };
    }, DEPTH_M);
  });

  test('checker period is 64 px at the centre of each rect', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const m = await window.__t11!.compose({});
      const row = 256;
      const out: number[][] = [];
      for (const [x0, x1] of [[16, 240], [272, 496]]) {
        const edges: number[] = [];
        for (let x = x0; x < x1; x++) {
          const a = m.baseColor[(row * m.w + x) * 4] >= 128;
          const b = m.baseColor[(row * m.w + x + 1) * 4] >= 128;
          if (a !== b) edges.push(x + 1);
        }
        out.push(edges.slice(1).map((e, i) => e - edges[i]));
      }
      return out;
    });
    for (const diffs of r) {
      expect(diffs.length).toBeGreaterThanOrEqual(2);
      for (const d of diffs) expect(Math.abs(d - 64)).toBeLessThanOrEqual(1);
    }
  });

  test('each rect starts at a joint above its bottom inner edge', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const m = await window.__t11!.compose({});
      // The inner bottom edge is at 512 - 5.12 px; row 500 lies in the first cell row.
      const px = (x: number, y: number) => Array.from(m.baseColor.slice((y * m.w + x) * 4, (y * m.w + x) * 4 + 4));
      return { a: px(20, 500), b: px(276, 500), expected: m.albedoBottomLeft };
    });
    expect(r.a).toEqual(r.expected);
    expect(r.b).toEqual(r.expected);
  });

  test('groove has rectId 0 and sits at least 0.9 * depthM below the rect centre', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const m = await window.__t11!.compose({});
      const i = (x: number, y: number) => y * m.w + x;
      return {
        grooveId: m.rectId[i(256, 256)],
        ids: [m.rectId[i(128, 256)], m.rectId[i(384, 256)]],
        grooveH: m.height[i(256, 256)],
        centreH: m.height[i(128, 256)],
        range: m.heightRangeM,
      };
    });
    expect(r.grooveId).toBe(0);
    expect(r.ids).toEqual([1, 2]);
    expect(r.centreH - r.grooveH).toBeGreaterThanOrEqual(0.9 * DEPTH_M);
    expect(r.range[0]).toBeCloseTo(-DEPTH_M, 6);
    expect(r.range[1]).toBeCloseTo(0, 3); // default height byte 128 is 0.502, not 0.5
  });

  test('heightToRgba8 normalizes height by heightRangeM', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const m = await window.__t11!.compose({});
      const px = (x: number, y: number) => Array.from(m.heightRgba8.slice((y * m.w + x) * 4, (y * m.w + x) * 4 + 4));
      return { groove: px(256, 256), centre: px(128, 256) };
    });
    expect(r.groove).toEqual([0, 0, 0, 255]);
    expect(r.centre).toEqual([255, 255, 255, 255]);
  });

  test('normal X on the right groove slope of rect 1 matches the Sobel sign of height', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const m = await window.__t11!.compose({});
      const x = 504, y = 256;
      const h = (dx: number, dy: number) => m.height[(y + dy) * m.w + (x + dx)];
      const sobelX = (h(1, -1) + 2 * h(1, 0) + h(1, 1)) - (h(-1, -1) + 2 * h(-1, 0) + h(-1, 1));
      const nx = (m.normal[(y * m.w + x) * 4] / 255) * 2 - 1;
      return { sobelX, nx };
    });
    // Height falls toward +X here, so a GL normal leans toward +X.
    expect(r.sobelX).toBeLessThan(0);
    expect(r.nx).toBeGreaterThan(0);
    expect(Math.sign(r.nx)).toBe(Math.sign(-r.sobelX));
  });

  test('albedo-only material composes with constant defaults', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const m = await window.__t11!.compose({ albedoOnly: true });
      const i = (128 * m.w + 128) * 4;
      return {
        rough: Array.from(m.roughness.slice(i, i + 4)),
        normal: Array.from(m.normal.slice(i, i + 4)),
      };
    });
    for (const c of r.rough.slice(0, 3)) expect(Math.abs(c - 128)).toBeLessThanOrEqual(1);
    expect(r.rough[3]).toBe(255);
    expect(Math.abs(r.normal[0] - 128)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.normal[1] - 128)).toBeLessThanOrEqual(1);
    expect(r.normal[2]).toBeGreaterThanOrEqual(254);
  });

  test('a DX normal map gives inverted G compared to the same map as GL', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const g = async (normal: 'gl' | 'dx') => {
        const m = await window.__t11!.compose({ albedoOnly: false, normal });
        return m.normal[(128 * m.w + 128) * 4 + 1];
      };
      return { gl: await g('gl'), dx: await g('dx') };
    });
    expect(r.gl).toBeGreaterThan(190);
    expect(r.dx).toBeLessThan(65);
    expect(Math.abs(r.gl + r.dx - 255)).toBeLessThanOrEqual(2);
  });
});

test('composeAtlas rejects more than 256 rects', async ({ page }) => {
  const msg = await page.evaluate(async () => {
    const { core, engine } = window.__hs!;
    const ctx = await engine.initGpu();
    const rects = Array.from({ length: 257 }, (_, i) => core.makeRect({ id: `r${i}`, x: i * 4, y: 0, w: 4, h: 4 }));
    const layout = {
      version: 1 as const, widthPx: 1028, heightPx: 4, worldWidthM: 1, rects, groove: core.DEFAULT_GROOVE,
    };
    const material = engine.uploadMaterial(ctx, {
      settings: {
        name: 'x', files: {}, normalConvention: 'gl', roughnessIsGloss: false, tileSizeM: [1, 1],
        heightScaleM: 0.02, period: core.CONTINUOUS, allowRotation: false,
      },
      images: {},
    });
    const placements = rects.map((r) => ({ rectId: r.id, originM: [0, 0] as [number, number], rotate90: false }));
    try {
      await engine.composeAtlas(ctx, { layout, material, placements, resolutionPx: 1028 });
      return 'no error';
    } catch (e) {
      return (e as Error).message;
    }
  });
  expect(msg).toMatch(/257 rects exceeds the maximum of 256/);
});

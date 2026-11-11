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

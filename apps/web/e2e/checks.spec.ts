import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRICKS = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../samples/pbr/bricks wall 13');

// Each test imports a material, analyses it and composes the 2048 px evaluation at least once.
test.describe.configure({ timeout: 90_000 });

const row = (page: Page, id: string) => page.locator(`[data-testid="check-row"][data-check-id="${id}"]`);

/** Imports bricks wall 13 and waits for the checks of the settled document (after the analysis). */
async function importBricks(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('folder-input').setInputFiles(BRICKS);
  await expect(page.getByTestId('material-name')).toHaveValue('bricks_wall_13');
  await expect(page.getByTestId('structure-type')).toHaveText('Piezas');
  await expect(page.getByTestId('check-row')).toHaveCount(6, { timeout: 30_000 });
}

test('readbackR32 reads r32float and r32uint row by row and rejects other formats', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__hs);
  const r = await page.evaluate(async () => {
    const hs = window.__hs!;
    await hs.store.getState().initGpu();
    const gpu = hs.store.getState().gpu!;
    // 70 px: rows are padded to 256 bytes in the copy.
    const w = 70, h = 3;
    const make = (format: GPUTextureFormat, data: ArrayBufferView) => {
      const t = gpu.device.createTexture({ size: [w, h], format, usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC });
      gpu.device.queue.writeTexture({ texture: t }, data, { bytesPerRow: w * 4 }, [w, h]);
      return t;
    };
    const f = new Float32Array(w * h).map((_, i) => i * 0.25 - 3);
    const u = new Uint32Array(w * h).map((_, i) => i * 65537);
    const tf = make('r32float', f), tu = make('r32uint', u);
    const rf = hs.engine.readbackR32(gpu, tf);
    const ru = hs.engine.readbackR32(gpu, tu);
    // The copies are submitted already: destroying now must not lose them.
    tf.destroy();
    tu.destroy();
    const [a, b] = await Promise.all([rf, ru]);
    const rgba = gpu.device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.COPY_SRC });
    const rejected = await hs.engine.readbackR32(gpu, rgba).then(() => false, () => true);
    rgba.destroy();
    return {
      sizes: [a.width, a.height, b.width, b.height],
      kinds: [a.data instanceof Float32Array, b.data instanceof Uint32Array],
      f: Array.from(a.data).every((v, i) => v === f[i]),
      u: Array.from(b.data).every((v, i) => v === u[i]),
      rejected,
    };
  });
  expect(r).toEqual({ sizes: [70, 3, 70, 3], kinds: [true, true], f: true, u: true, rejected: true });
});

test.describe('with bricks wall 13', () => {
  test.skip(!existsSync(BRICKS), 'samples/pbr/bricks wall 13 not present');

  test('the Comprobaciones panel lists the six checks and the normal is coherent', async ({ page }) => {
    await importBricks(page);
    await expect(page.getByTestId('checks')).toBeVisible();
    const ids = await page.getByTestId('check-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-check-id')));
    expect(ids).toEqual(['coverage', 'islands', 'normal', 'proportions', 'bleed', 'substrate']);
    await expect(row(page, 'normal')).toHaveAttribute('data-status', 'ok');
    await expect(row(page, 'coverage')).toHaveAttribute('data-status', 'ok');
    await expect(row(page, 'islands')).toHaveAttribute('data-status', 'ok');
    // The checks run on the 2048 px evaluation, not on the 1024 px preview.
    expect(await page.evaluate(() => {
      const s = window.__hs!.store.getState();
      return [s.checks!.width, s.atlas!.resolutionPx];
    })).toEqual([2048, 1024]);
    // The status bar counts the checks that are not ok.
    const flagged = await page.evaluate(() => window.__hs!.store.getState().checks!.results.filter((r) => r.status !== 'ok').length);
    await expect(page.getByTestId('checks-warnings')).toHaveText(`Comprobaciones: ${flagged}`);
  });

  test('the bleed row warns once the export resolution makes the groove floor thinner than 4 px', async ({ page }) => {
    await importBricks(page);
    const setRes = (r: number) =>
      page.evaluate((resolutionPx) => window.__hs!.store.getState().updateNode<'output'>('output', { resolutionPx }), r);
    // The visible groove is 6 mm + 2 · 3 mm bevel = 12 mm in 8 m: 6.1 px at the default 4096, 0.77 px at 512 (R35).
    expect(await page.evaluate(() =>
      (window.__hs!.store.getState().doc!.nodes.find((n) => n.type === 'output')!.params as { resolutionPx: number })
        .resolutionPx)).toBe(4096);
    await expect(row(page, 'bleed')).toHaveAttribute('data-status', 'ok');
    await setRes(512);
    await expect(row(page, 'bleed')).toHaveAttribute('data-status', 'warn', { timeout: 20_000 });
    await expect(row(page, 'bleed')).toContainText('mip 2');
  });

  test('clicking a row with points centres the atlas view on the first point', async ({ page }) => {
    await importBricks(page);
    // A period no rect is a multiple of: every rect gets a proportions warning, with its centre as point.
    await page.evaluate(() => {
      const s = window.__hs!.store.getState();
      const p = s.material!.settings.period;
      return s.updateSettings({ period: { ...p, x: 0.37, cutAllowedX: false }, periodUserSet: true });
    });
    await expect(row(page, 'proportions')).toHaveAttribute('data-status', 'warn', { timeout: 20_000 });
    // Rows of an older atlas are dimmed and not clickable; wait for the current results.
    await expect(page.getByTestId('checks')).not.toHaveAttribute('data-pending', 'true', { timeout: 20_000 });
    await expect(row(page, 'proportions')).toHaveAttribute('data-status', 'warn');
    const stage = page.getByTestId('atlas-stage');
    const before = await stage.evaluate((el) => (el as HTMLElement).style.transform);
    await row(page, 'proportions').click();
    await expect.poll(() => stage.evaluate((el) => (el as HTMLElement).style.transform)).not.toBe(before);
    const r = await page.evaluate(() => {
      const s = window.__hs!.store.getState();
      const c = s.checks!;
      const p = c.results.find((x) => x.id === 'proportions')!.points![0];
      const st = document.querySelector('[data-testid="atlas-stage"]')!.getBoundingClientRect();
      const host = document.querySelector('[data-testid="atlas-view"]')!.getBoundingClientRect();
      return {
        x: st.left + (p[0] / c.width) * st.width, y: st.top + (p[1] / c.height) * st.height,
        cx: host.left + host.width / 2, cy: host.top + host.height / 2,
      };
    });
    expect(Math.abs(r.x - r.cx)).toBeLessThan(2);
    expect(Math.abs(r.y - r.cy)).toBeLessThan(2);
  });

  test('with a second set the substrate row compares its colour with the joints', async ({ page }) => {
    await importBricks(page);
    await expect(row(page, 'substrate')).toHaveAttribute('title', /propio material/);
    const r = await page.evaluate(async () => {
      const store = window.__hs!.store;
      const dir = 'pbr/concrete%20wall%2001';
      const names: string[] = await (await fetch(`/samples-index/${dir}`)).json();
      const files = await Promise.all(
        names.map(async (n) => new File([await (await fetch(`/samples/${dir}/${encodeURIComponent(n)}`)).blob()], n)),
      );
      await store.getState().importSubstrate(files);
      const w = store.getState().doc!.nodes.find((n) => n.type === 'wear')!.params as { substrate: object };
      store.getState().updateNode<'wear'>('wear', { substrate: { ...w.substrate, source: 'secondSet' } as never });
      return !!store.getState().substrate;
    });
    expect(r).toBe(true);
    // Both means exist (a material with pieces, a second set loaded): the message states the colour difference.
    await expect(row(page, 'substrate')).toHaveAttribute('title', /diferencia/, { timeout: 20_000 });
    // R37: the joint colour is read where the structure says joint. bricks wall 13 is grey (mortar ≈ 82, bricks ≈ 97),
    // so aligned joints are ΔE ≈ 6.6 from the pieces; joint ids shifted by (7, 5) texels average a brick/mortar mix,
    // ΔE ≈ 3.
    const d = await page.evaluate(() => {
      const hs = window.__hs!;
      const s = hs.store.getState();
      const { width: w, height: h, pieceId } = s.structure!.result;
      const g = new OffscreenCanvas(w, h).getContext('2d')!;
      g.imageSmoothingQuality = 'high';
      g.drawImage(s.material!.images.baseColor!, 0, 0, w, h);
      const px = g.getImageData(0, 0, w, h).data;
      const mean = (sel: (x: number, y: number) => boolean) => {
        const sum = [0, 0, 0];
        let n = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (!sel(x, y)) continue;
            for (let c = 0; c < 3; c++) sum[c] += px[(y * w + x) * 4 + c];
            n++;
          }
        }
        return sum.map((v) => v / n) as [number, number, number];
      };
      const pieces = mean((x, y) => pieceId[y * w + x] !== 0);
      const shifted = mean((x, y) => pieceId[((y + 5) % h) * w + ((x + 7) % w)] === 0);
      const joints = hs.jointMean();
      return { aligned: joints ? hs.core.deltaE76(joints, pieces) : -1, shifted: hs.core.deltaE76(shifted, pieces) };
    });
    expect(d.aligned).toBeGreaterThan(5);
    expect(d.aligned).toBeGreaterThan(2 * d.shifted);
  });

  test('islands stays ok on the defaults at intensity 0.5 and 1, seeds 0 and 7 (R38)', async ({ page }) => {
    await importBricks(page);
    for (const p of [{ intensity: 0.5, seed: 0 }, { intensity: 1, seed: 0 }, { intensity: 0.5, seed: 7 }, { intensity: 1, seed: 7 }]) {
      const r = await page.evaluate(async (q) => {
        const store = window.__hs!.store;
        store.getState().updateNode<'wear'>('wear', q);
        // Wait for the recomposition, then evaluate it (an evaluation superseded by it resolves null).
        for (;;) {
          await new Promise((ok) => setTimeout(ok, 100));
          const s = store.getState();
          if (!s.atlas || s.atlas.doc !== s.doc) continue;
          const res = await s.runEvaluation();
          if (res && store.getState().atlas?.doc === s.doc) {
            const isl = res.find((x) => x.id === 'islands')!;
            return { status: isl.status, n: isl.points?.length ?? 0 };
          }
        }
      }, p);
      expect(r, JSON.stringify(p)).toEqual({ status: 'ok', n: 0 });
    }
  });

  test('evaluations never overlap, and reusing a 2048 px preview gives the same results as composing', async ({ page }) => {
    await importBricks(page);
    const r = await page.evaluate(async () => {
      const store = window.__hs!.store;
      // Two requests at once: the first is superseded while queued and skipped.
      const [a, b] = await Promise.all([store.getState().runEvaluation(), store.getState().runEvaluation()]);
      return { a, b: b?.length };
    });
    expect(r).toEqual({ a: null, b: 6 });
    expect(await page.evaluate(() => window.__hs!.evalStats.peak)).toBe(1);

    const evaluate = () => page.evaluate(async () => {
      const res = await window.__hs!.store.getState().runEvaluation({ exportResolutionPx: 4096 });
      return res!.map((x) => [x.id, x.status, x.message, x.rectIds.length, x.points?.length ?? 0]);
    });
    const composed = await evaluate();
    await page.evaluate(() => window.__hs!.store.getState().setPreviewRes(2048));
    await page.waitForFunction(() => window.__hs!.store.getState().atlas?.resolutionPx === 2048);
    const before = await page.evaluate(() => window.__hs!.evalStats.composes);
    expect(await evaluate()).toEqual(composed);
    // The current 2048 px preview was read directly: no composition of its own.
    expect(await page.evaluate(() => window.__hs!.evalStats.composes)).toBe(before);
    expect(await page.evaluate(() => window.__hs!.evalStats.peak)).toBe(1);
  });
});

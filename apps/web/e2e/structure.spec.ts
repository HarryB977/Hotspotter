import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PBR = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../samples/pbr');
const BRICKS = resolve(PBR, 'bricks wall 13');
const CONCRETE = resolve(PBR, 'concrete wall 01');

test.skip(!existsSync(BRICKS) || !existsSync(CONCRETE), 'samples/pbr bricks wall 13 / concrete wall 01 not present');
// Each test imports a material and runs one or more CPU analyses (about 0.5–1.5 s each).
test.describe.configure({ timeout: 60_000 });

const PERIOD_Y = 'Periodo (m, vacío = continuo) Y';

async function importBricks(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('folder-input').setInputFiles(BRICKS);
  await expect(page.getByTestId('material-name')).toHaveValue('bricks_wall_13');
  await expect(page.getByTestId('structure-type')).toHaveText('Piezas');
  await page.waitForFunction(() => {
    const s = window.__hs?.store.getState();
    return !!s?.atlas && !!s.structure && s.atlas.maps.pieceId.width === s.atlas.resolutionPx;
  });
}

/**
 * Reads the atlas pieceId / jointDistM maps and returns, for sample pixels inside the largest rect, the GPU piece
 * id next to the id the CPU analysis gives at the same material point (atlasPxToMaterialM + nearest texel).
 */
async function sampleStructure(page: Page) {
  return page.evaluate(async () => {
    const hs = window.__hs!;
    const s = hs.store.getState();
    const gpu = s.gpu!;
    const a = s.atlas!;
    const res = s.structure!.result;
    const ids = await hs.engine.readbackRgba8(gpu, a.maps.pieceId);
    const dist = await hs.engine.readbackRgba8(gpu, a.maps.jointDistM);
    const W = a.maps.pieceId.width;
    const pid = new Uint32Array(ids.data.buffer, ids.data.byteOffset, ids.data.byteLength / 4);
    const jd = new Float32Array(dist.data.buffer, dist.data.byteOffset, dist.data.byteLength / 4);
    const big = [...a.layout.rects].sort((p, q) => q.w * q.h - p.w * p.h)[0];
    const pl = a.placements.find((p) => p.rectId === big.id)!;
    const refScale = W / a.layout.widthPx;
    const ppmAtlas = W / a.layout.worldWidthM;
    const step = Math.round(0.01 * ppmAtlas);
    const tile = s.material!.settings.tileSizeM;
    const pairs: { a: number; b: number }[] = [];
    const cpu: { gpu: number; cpu: number }[] = [];
    for (let j = 0; j < 24; j++) {
      for (let i = 0; i < 24; i++) {
        const x = Math.floor((big.x + big.w * (0.2 + (0.6 * i) / 23)) * refScale);
        const y = Math.floor((big.y + big.h * (0.2 + (0.6 * j) / 23)) * refScale);
        const k = y * W + x;
        // Same brick 1 cm to the right: only where the joint is more than 1.5 cm away.
        if (pid[k] > 0 && jd[k] > 0.015) pairs.push({ a: pid[k], b: pid[k + step] });
        const m = hs.core.atlasPxToMaterialM(a.layout, big, pl, [(x + 0.5) / refScale, (y + 0.5) / refScale]);
        const u = m[0] / tile[0] - Math.floor(m[0] / tile[0]);
        const v = 1 - m[1] / tile[1];
        const vv = v - Math.floor(v);
        const tx = Math.min(res.width - 1, Math.floor(u * res.width));
        const ty = Math.min(res.height - 1, Math.floor(vv * res.height));
        cpu.push({ gpu: pid[k], cpu: res.pieceId[ty * res.width + tx] });
      }
    }
    return { pairs, cpu, step };
  });
}

test('bricks wall 13 is analysed on import: pieces and a proposed Y period', async ({ page }) => {
  await importBricks(page);
  await expect.poll(async () => Number(await page.getByLabel(PERIOD_Y).inputValue())).toBeGreaterThan(0);
  const st = await page.evaluate(() => {
    const s = window.__hs!.store.getState();
    const node = s.doc!.nodes.find((n) => n.type === 'structure')!.params as { type: string; analyzed: boolean };
    return { node, periodY: s.material!.settings.period.y };
  });
  expect(st.node).toEqual(expect.objectContaining({ type: 'pieces', analyzed: true }));
  expect(st.periodY).toBeGreaterThan(0);
});

test('the Piezas tab colours the atlas by piece', async ({ page }) => {
  await importBricks(page);
  await page.getByRole('tab', { name: 'Piezas' }).click();
  await expect(page.getByRole('tab', { name: 'Piezas' })).toHaveAttribute('data-state', 'active');
  // A WebGPU canvas cannot be read back after it is presented: sample a screenshot of what is shown.
  const sample = async () => {
    const png = (await page.getByTestId('atlas-canvas').screenshot()).toString('base64');
    return page.evaluate(async (b64) => {
      const hs = window.__hs!;
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c2 = document.createElement('canvas');
      c2.width = img.width;
      c2.height = img.height;
      const g = c2.getContext('2d')!;
      g.drawImage(img, 0, 0);
      const s = hs.store.getState();
      const a = s.atlas!;
      const ids = await hs.engine.readbackRgba8(s.gpu!, a.maps.pieceId);
      const W = a.maps.pieceId.width;
      const pid = new Uint32Array(ids.data.buffer, ids.data.byteOffset, ids.data.byteLength / 4);
      // Same hash as the ID view (AtlasView ID_FS).
      const colour = (id: number) => {
        if (id === 0) return [13, 13, 13];
        let h = Math.imul(id, 2654435761) >>> 0;
        h = (h ^ (h >>> 15)) >>> 0;
        h = Math.imul(h, 2246822519) >>> 0;
        h = (h ^ (h >>> 13)) >>> 0;
        return [h & 255, (h >>> 8) & 255, (h >>> 16) & 255].map((c) => Math.round((0.25 + (0.65 * c) / 255) * 255));
      };
      const big = [...a.layout.rects].sort((p, q) => q.w * q.h - p.w * p.h)[0];
      const k = img.width / a.layout.widthPx;
      const refScale = W / a.layout.widthPx;
      const seen = new Set<number>();
      let matches = 0;
      // 8 × 8 samples over the central half of the largest rect.
      for (let j = 0; j < 8; j++) {
        for (let i = 0; i < 8; i++) {
          const fx = big.x + big.w * (0.25 + (0.5 * i) / 7);
          const fy = big.y + big.h * (0.25 + (0.5 * j) / 7);
          const d = g.getImageData(Math.floor(fx * k), Math.floor(fy * k), 1, 1).data;
          seen.add(d[0] | (d[1] << 8) | (d[2] << 16));
          const want = colour(pid[Math.floor(fy * refScale) * W + Math.floor(fx * refScale)]);
          if (want.every((c, n) => Math.abs(c - d[n]) <= 3)) matches++;
        }
      }
      return { distinct: seen.size, matches };
    }, png);
  };
  await expect.poll(async () => (await sample()).distinct).toBeGreaterThan(20);
  // The shown colours are the piece-id hash, not the albedo (points near a joint blend in the downscaled view).
  expect((await sample()).matches).toBeGreaterThan(32);
});

test('pieceId is stable within a brick and matches the CPU analysis at the same material point', async ({ page }) => {
  await importBricks(page);
  const { pairs, cpu, step } = await sampleStructure(page);
  expect(step).toBeGreaterThanOrEqual(1);
  expect(pairs.length).toBeGreaterThan(20);
  for (const p of pairs) expect(p.b).toBe(p.a);
  // Allow a few texel-boundary disagreements (float rounding at piece edges).
  const agree = cpu.filter((c) => c.gpu === c.cpu).length;
  expect(agree / cpu.length).toBeGreaterThan(0.97);
});

test('with the material rotated 90°, pieceId follows the same UV mapping as the albedo', async ({ page }) => {
  await importBricks(page);
  await page.getByTestId('base-rotation').click();
  await page.getByRole('option', { name: '90°' }).click();
  await page.waitForFunction(() => {
    const a = window.__hs!.store.getState().atlas;
    return !!a && a.placements.length > 0 && a.placements.every((p) => p.rotate90);
  });
  const { pairs, cpu } = await sampleStructure(page);
  for (const p of pairs) expect(p.b).toBe(p.a);
  const agree = cpu.filter((c) => c.gpu === c.cpu).length;
  expect(agree / cpu.length).toBeGreaterThan(0.97);
});

test('concrete wall 01 is continuous', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('folder-input').setInputFiles(CONCRETE);
  await expect(page.getByTestId('structure-type')).toHaveText('Continuo');
});

test('editing the threshold stores it and re-analyses; Detectar re-runs the analysis', async ({ page }) => {
  await importBricks(page);
  const field = page.getByTestId('structure-threshold');
  const suggested = await page.evaluate(() => window.__hs!.store.getState().structure!.result.suggestedThreshold);
  await expect.poll(async () => Number(await field.inputValue())).toBeCloseTo(suggested, 2);
  const before = await page.evaluate(() => window.__hs!.store.getState().structure!.result);
  await field.fill('0.995');
  await field.press('Enter');
  await expect.poll(() => page.evaluate(() => {
    const s = window.__hs!.store.getState();
    const node = s.doc!.nodes.find((n) => n.type === 'structure')!.params as { threshold: number | null };
    return { threshold: node.threshold, used: s.structure!.result.threshold };
  })).toEqual({ threshold: 0.995, used: 0.995 });
  const after = await page.evaluate(() => window.__hs!.store.getState().structure!.result.pieceCount);
  expect(after).not.toBe(before.pieceCount);

  const prev = await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__prevStructure = window.__hs!.store.getState().structure;
    return true;
  });
  expect(prev).toBe(true);
  await page.getByTestId('structure-detect').click();
  await expect.poll(() => page.evaluate(() =>
    window.__hs!.store.getState().structure !== (window as unknown as Record<string, unknown>).__prevStructure)).toBe(true);
});

test('a user-set period is not overwritten by a later analysis', async ({ page }) => {
  await importBricks(page);
  await page.getByLabel(PERIOD_Y).fill('0.2');
  await page.getByLabel(PERIOD_Y).blur();
  await expect.poll(() => page.evaluate(() => window.__hs!.store.getState().material!.settings.periodUserSet)).toBe(true);
  await page.getByTestId('structure-detect').click();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__hs!.store.getState().material!.settings.period.y)).toBe(0.2);
});

test('an analysis is discarded when the material changes while it runs', async ({ page }) => {
  await importBricks(page);
  const r = await page.evaluate(async () => {
    const store = window.__hs!.store;
    const before = store.getState().structure;
    // Start an analysis, then replace the material's maps before it commits.
    const pending = store.getState().analyze();
    await store.getState().assignMap('bricks_wall_13_height_1k.png', null);
    await pending;
    const s = store.getState();
    return {
      replaced: s.structure !== before,
      // The surviving result is the albedo analysis triggered by the reassignment, not the stale height one.
      fromCurrent: s.structure?.source === 'baseColor',
    };
  });
  expect(r).toEqual({ replaced: true, fromCurrent: true });
});

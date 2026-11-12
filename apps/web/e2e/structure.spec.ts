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
  // Only the count: the full result holds 512² id and distance arrays.
  const beforeCount = await page.evaluate(() => window.__hs!.store.getState().structure!.result.pieceCount);
  await field.fill('0.995');
  await field.press('Enter');
  await expect.poll(() => page.evaluate(() => {
    const s = window.__hs!.store.getState();
    const node = s.doc!.nodes.find((n) => n.type === 'structure')!.params as { threshold: number | null };
    return { threshold: node.threshold, used: s.structure!.result.threshold };
  })).toEqual({ threshold: 0.995, used: 0.995 });
  const after = await page.evaluate(() => window.__hs!.store.getState().structure!.result.pieceCount);
  expect(after).not.toBe(beforeCount);

  const prev = await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__prevStructure = window.__hs!.store.getState().structure;
    return true;
  });
  expect(prev).toBe(true);
  await page.getByTestId('structure-detect').click();
  await expect.poll(() => page.evaluate(() =>
    window.__hs!.store.getState().structure !== (window as unknown as Record<string, unknown>).__prevStructure)).toBe(true);
});

/** Marks the current structure state so a later poll can wait for the next analysis commit. */
async function markStructure(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__mark = window.__hs!.store.getState().structure;
  });
}

async function nextStructure(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() =>
    window.__hs!.store.getState().structure !== (window as unknown as Record<string, unknown>).__mark)).toBe(true);
}

const settingsOf = (page: Page) => page.evaluate(() => {
  const s = window.__hs!.store.getState();
  return { y: s.material!.settings.period.y, userSet: s.material!.settings.periodUserSet, detectedY: s.structure!.result.period.y };
});

test('automatic re-analyses keep a user-set period; Detectar resets it to the detected one (R25)', async ({ page }) => {
  await importBricks(page);
  await page.getByLabel(PERIOD_Y).fill('0.2');
  await page.getByLabel(PERIOD_Y).blur();
  await expect.poll(() => page.evaluate(() => window.__hs!.store.getState().material!.settings.periodUserSet)).toBe(true);

  // Automatic re-analysis (threshold edit) respects the flag.
  await markStructure(page);
  await page.getByTestId('structure-threshold').fill('0.97');
  await page.getByTestId('structure-threshold').press('Enter');
  await nextStructure(page);
  expect(await settingsOf(page)).toEqual(expect.objectContaining({ y: 0.2, userSet: true }));

  // Detectar applies the detected period and clears the flag.
  await markStructure(page);
  await page.getByTestId('structure-detect').click();
  await nextStructure(page);
  const after = await settingsOf(page);
  expect(after.userSet).toBe(false);
  expect(after.detectedY).toBeGreaterThan(0);
  expect(after.y).toBe(after.detectedY);
});

test('focusing and leaving the threshold and period fields commits nothing', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('folder-input').setInputFiles(CONCRETE);
  await expect(page.getByTestId('structure-type')).toHaveText('Continuo');
  await page.waitForFunction(() => !!window.__hs?.store.getState().structure);
  // No joints found: the automatic threshold field is empty.
  await expect(page.getByTestId('structure-threshold')).toHaveValue('');
  const docBefore = await page.evaluate(() => window.__hs!.store.getState().doc);
  for (const field of [page.getByTestId('structure-threshold'), page.getByLabel(PERIOD_Y)]) {
    await field.focus();
    await field.blur();
  }
  await page.waitForTimeout(200);
  const r = await page.evaluate((before) => {
    const s = window.__hs!.store.getState();
    const node = s.doc!.nodes.find((n) => n.type === 'structure')!.params as { threshold: number | null };
    return { threshold: node.threshold, userSet: s.material!.settings.periodUserSet ?? false, same: JSON.stringify(s.doc) === JSON.stringify(before) };
  }, docBefore);
  expect(r).toEqual({ threshold: null, userSet: false, same: true });
  await expect(page.getByTestId('structure-type')).toHaveText('Continuo');

  // Same on bricks, whose field shows the suggested threshold: a blur must not pin it.
  await page.getByTestId('folder-input').setInputFiles(BRICKS);
  await page.getByTestId('import-replace').click();
  await expect(page.getByTestId('structure-type')).toHaveText('Piezas');
  await expect.poll(async () => (await page.getByTestId('structure-threshold').inputValue()) !== '').toBe(true);
  await page.getByTestId('structure-threshold').focus();
  await page.getByTestId('structure-threshold').blur();
  await page.waitForTimeout(200);
  expect(await page.evaluate(() =>
    (window.__hs!.store.getState().doc!.nodes.find((n) => n.type === 'structure')!.params as { threshold: number | null }).threshold,
  )).toBeNull();
});

test('an analysis is discarded when the material maps change while it runs', async ({ page }) => {
  await importBricks(page);
  const r = await page.evaluate(async () => {
    const store = window.__hs!.store;
    const before = store.getState().structure;
    // Start an analysis, then swap the maps object without requesting a new analysis.
    const pending = store.getState().analyze();
    const m = store.getState().material!;
    store.setState({ material: { ...m, images: { ...m.images } } });
    await pending;
    return store.getState().structure === before;
  });
  // Without the staleness guard the pending analysis would commit a new structure.
  expect(r).toBe(true);
});

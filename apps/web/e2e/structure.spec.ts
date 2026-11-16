import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectLayer } from './helpers';

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
  await selectLayer(page, 'structure');
  await expect(page.getByTestId('structure-type')).toHaveText('Piezas');
  // The analysis runs in a Worker, so the first atlas may be composed before the structure lands: wait for the
  // atlas composed from the current structure.
  await page.waitForFunction(() => {
    const s = window.__hs?.store.getState();
    return !!s?.atlas && !!s.structure && s.atlas.structure === s.structure &&
      s.atlas.maps.pieceId.width === s.atlas.resolutionPx;
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
  await selectLayer(page, 'structure');
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
  await selectLayer(page, 'structure');
  await expect(page.getByTestId('structure-type')).toHaveText('Continuo');
  await page.waitForFunction(() => !!window.__hs?.store.getState().structure);
  // No joints found: the automatic threshold field is empty.
  await expect(page.getByTestId('structure-threshold')).toHaveValue('');
  const docBefore = await page.evaluate(() => window.__hs!.store.getState().doc);
  for (const field of [page.getByTestId('structure-threshold'), page.getByLabel(PERIOD_Y)]) {
    await field.focus();
    await field.blur();
  }
  await page.waitForFunction(() => window.__hs!.store.getState().analysisIdle);
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
  // The replace import selects Desgaste again: select Estructura once it has landed.
  await expect(page.getByTestId('material-name')).toHaveValue('bricks_wall_13');
  await selectLayer(page, 'structure');
  await expect(page.getByTestId('structure-type')).toHaveText('Piezas');
  await expect.poll(async () => (await page.getByTestId('structure-threshold').inputValue()) !== '').toBe(true);
  await page.getByTestId('structure-threshold').focus();
  await page.getByTestId('structure-threshold').blur();
  await page.waitForFunction(() => window.__hs!.store.getState().analysisIdle);
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

test('analysis does not block the main thread', async ({ page }) => {
  await importBricks(page);
  await page.waitForFunction(() => window.__hs!.store.getState().analysisIdle);
  const r = await page.evaluate(async () => {
    const store = window.__hs!.store;
    const prev = store.getState().structure;
    // Wall-clock time between frame callbacks (a frame's own timestamp can predate a long task).
    let last = 0;
    let max = 0;
    let running = true;
    const tick = () => {
      const now = performance.now();
      max = Math.max(max, now - last);
      last = now;
      if (running) requestAnimationFrame(tick);
    };
    await new Promise<void>((r) => requestAnimationFrame(() => { last = performance.now(); r(); }));
    requestAnimationFrame(tick);
    void store.getState().analyze({ applyPeriod: true });
    await new Promise<void>((r) => {
      const check = () => (store.getState().analysisIdle ? r() : setTimeout(check, 10));
      check();
    });
    running = false;
    return { maxGap: max, analysed: store.getState().structure !== prev };
  });
  expect(r.analysed).toBe(true);
  expect(r.maxGap).toBeLessThan(120);
});

test('a worker crash during analysis shows the Spanish error once and the next analysis works', async ({ page }) => {
  await importBricks(page);
  const failures: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && m.text().startsWith('structure analysis failed')) failures.push(m.text());
  });
  const crashed = 'El análisis en segundo plano falló; vuelve a intentarlo.';
  // Every call pending when the Worker dies fails with the crash.
  const direct = await page.evaluate(async () => {
    const hs = window.__hs!;
    const gray = () => ({ width: 64, height: 64, data: new Float32Array(64 * 64) });
    hs.failNextWorkerCall('analyze');
    const settled = await Promise.allSettled([
      hs.workerCall('analyze', { gray: gray(), tileSizeM: [1, 1] }, [], { supersede: true }),
      hs.workerCall('analyze', { gray: gray(), tileSizeM: [1, 1] }, [], { supersede: true }),
    ]);
    return settled.map((s) => (s.status === 'rejected' ? (s.reason as Error).message : 'fulfilled'));
  });
  expect(direct).toEqual([crashed, crashed]);
  const before = await page.evaluate(async () => {
    const hs = window.__hs!;
    const prev = hs.store.getState().structure;
    hs.failNextWorkerCall('analyze');
    const settled = await Promise.allSettled([hs.store.getState().analyze(), hs.store.getState().analyze()]);
    const s = hs.store.getState();
    return { settled: settled.map((r) => r.status), kept: s.structure === prev, idle: s.analysisIdle };
  });
  expect(before).toEqual({ settled: ['fulfilled', 'fulfilled'], kept: true, idle: true });
  await expect(page.getByTestId('structure-error')).toHaveText(crashed);
  expect(failures).toHaveLength(1);
  const after = await page.evaluate(async () => {
    const store = window.__hs!.store;
    const prev = store.getState().structure;
    await store.getState().analyze();
    const s = store.getState();
    return { replaced: s.structure !== null && s.structure !== prev, error: s.structureError, idle: s.analysisIdle };
  });
  expect(after).toEqual({ replaced: true, error: null, idle: true });
  await expect(page.getByTestId('structure-error')).toHaveCount(0);
});

test('the Worker skips a queued opted-in analysis that a newer one superseded, never one that did not opt in', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__hs);
  const r = await page.evaluate(async () => {
    const hs = window.__hs!;
    const gray = () => {
      const data = new Float32Array(512 * 512);
      for (let i = 0; i < data.length; i++) data[i] = ((i * 2654435761) >>> 0) / 2 ** 32;
      return { width: 512, height: 512, data };
    };
    const calls = [true, true, false, true].map((supersede) => {
      const g = gray();
      return hs.workerCall('analyze', { gray: g, tileSizeM: [1, 1] }, [g.data.buffer], { supersede });
    });
    const out = await Promise.all(calls);
    return out.map((o) => (o === null ? null : o.width));
  });
  // The first may already be running; the second is always queued behind the last's arrival. The third did not opt
  // in, so nothing skips it.
  expect(r.slice(1)).toEqual([null, 512, 512]);
});

test('the export waits for an analysis in flight and uses its structure (R43)', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await importBricks(page);
  await page.waitForFunction(() => window.__hs!.store.getState().analysisIdle);
  const files = (dir: string) =>
    ['WearMask', 'BaseColor'].map((k) => readFileSync(join(dir, `bricks_wall_13_${k}.png`)).toString('base64'));
  const exportNow = (dir: string) =>
    page.evaluate((d) => window.__hs!.exportProject({ dir: d, preset: 'unity-urp', resolutionPx: 1024 }), dir);

  const old = testInfo.outputPath('old');
  await exportNow(old);

  // The dialog blocks Exportar while the analysis runs.
  await page.getByTestId('export-open').click();
  await page.getByTestId('export-dir').fill(testInfo.outputPath('unused'));
  await expect(page.getByTestId('export-run')).toBeEnabled();
  await page.evaluate(() => void window.__hs!.store.getState().analyze());
  await expect(page.getByTestId('export-run')).toBeDisabled();
  await expect(page.getByTestId('export-analyzing')).toHaveText('Analizando la estructura…');
  await page.waitForFunction(() => window.__hs!.store.getState().analysisIdle);
  await expect(page.getByTestId('export-run')).toBeEnabled();
  await expect(page.getByTestId('export-analyzing')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // An export started right after a threshold change waits for the re-analysis.
  const during = testInfo.outputPath('during');
  const startedBusy = await page.evaluate(async (d) => {
    const hs = window.__hs!;
    const analysis = hs.store.getState().setStructureThreshold(0.9);
    const busy = !hs.store.getState().analysisIdle;
    await hs.exportProject({ dir: d, preset: 'unity-urp', resolutionPx: 1024 });
    await analysis;
    return busy;
  }, during);
  expect(startedBusy).toBe(true);
  const after = testInfo.outputPath('after');
  await exportNow(after);

  expect(files(during)).toEqual(files(after));
  // The threshold changes the structure, so an export with the old one would differ.
  expect(files(old)).not.toEqual(files(after));
});

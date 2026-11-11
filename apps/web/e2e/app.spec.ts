import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../samples/pbr/bricks wall 13');

test.skip(!existsSync(SAMPLE_DIR), 'samples/pbr/bricks wall 13 not present');

test('loads with title and imports the bricks wall 13 folder', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Hotspotter');
  await expect(page.getByTestId('webgpu-error')).toHaveCount(0);

  // A webkitdirectory input takes the directory itself.
  await page.getByTestId('folder-input').setInputFiles(SAMPLE_DIR);

  await expect(page.getByTestId('material-name')).toHaveText('bricks_wall_13');
  await expect(page.getByTestId('map-row')).toHaveCount(6);
  await expect(page.getByTestId('normal-convention')).toHaveText('GL');
  await expect(page.getByTestId('ignored-file')).toHaveCount(1);
  await expect(page.getByTestId('webgpu-error')).toHaveCount(0);
});

test('an undecodable image shows a panel error and keeps the app shell', async ({ page }, testInfo) => {
  const dir = testInfo.outputPath('corrupt');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'broken_basecolor_1k.png'), 'not a png');

  await page.goto('/');
  await page.getByTestId('folder-input').setInputFiles(dir);

  await expect(page.getByTestId('import-error')).toBeVisible();
  await expect(page.getByTestId('left-column')).toBeVisible();
  await expect(page.getByTestId('webgpu-error')).toHaveCount(0);
});

test('a folder without recognised maps shows the no-maps message', async ({ page }, testInfo) => {
  const dir = testInfo.outputPath('nomaps');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'photo.png'), 'x');

  await page.goto('/');
  await page.getByTestId('folder-input').setInputFiles(dir);

  await expect(page.getByTestId('import-error')).toHaveText('No se reconocieron mapas en los archivos.');
  await expect(page.getByTestId('webgpu-error')).toHaveCount(0);
});

test('a settings change during an in-flight import does not strand the import', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__hs);
  const r = await page.evaluate(async () => {
    const store = window.__hs!.store;
    const base = '/samples/pbr/bricks%20wall%2013/';
    const names: string[] = await (await fetch('/samples-index/pbr/bricks%20wall%2013')).json();
    const files = await Promise.all(
      names.map(async (n) => new File([await (await fetch(base + encodeURIComponent(n))).blob()], n)),
    );
    await store.getState().importFiles(files);
    const second = store.getState().importFiles(files);
    await store.getState().updateSettings({ tileSizeM: [2, 2] });
    await store.getState().updateSettings({ normalConvention: 'dx' });
    await second;
    const s = store.getState();
    return { importing: s.importing, name: s.material?.settings.name, error: s.importError, hasGpu: !!s.gpuMaterial };
  });
  expect(r).toEqual({ importing: false, name: 'bricks_wall_13', error: null, hasGpu: true });
});

test.describe('layout, inspector and atlas view', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('folder-input').setInputFiles(SAMPLE_DIR);
    await expect(page.getByTestId('material-name')).toHaveText('bricks_wall_13');
  });

  const rectCount = (page: import('@playwright/test').Page) => page.locator('[data-rect-id]').count();

  test('the walls preset composes a non-uniform atlas with one overlay rect per layout rect', async ({ page }) => {
    await expect(page.getByTestId('atlas-canvas')).toBeVisible();
    await page.waitForFunction(() => !!window.__hs?.lastAtlas);
    const distinct = await page.evaluate(async () => {
      const hs = window.__hs!;
      const ctx = hs.store.getState().gpu!;
      const { data } = await hs.engine.readbackRgba8(ctx, hs.lastAtlas!.baseColor);
      const seen = new Set<number>();
      for (let i = 0; i < data.length; i += 4 * 97) seen.add(data[i] | (data[i + 1] << 8) | (data[i + 2] << 16));
      return seen.size;
    });
    expect(distinct).toBeGreaterThan(8);

    const expected = await page.evaluate(() => window.__hs!.store.getState().atlas!.layout.rects.length);
    expect(expected).toBeGreaterThan(0);
    await expect(page.locator('[data-rect-id]')).toHaveCount(expected);
    await expect(page.getByTestId('atlas-info')).toHaveText(/^1024² · 128 px\/m · GPU \d+ ms$/);
  });

  test('auto mode with period Y 0.075 reports no proportion issues, and the seed changes the layout', async ({ page }) => {
    await page.getByLabel('Periodo (m, vacío = continuo) Y').fill('0.075');
    await page.getByLabel('Periodo (m, vacío = continuo) Y').blur();
    await page.getByTestId('layout-mode').click();
    await page.getByRole('option', { name: 'Automático' }).click();
    await expect(page.getByTestId('layout-seed')).toBeVisible();
    await expect(page.getByTestId('proportion-issues')).toHaveText('0');

    const signature = () =>
      page.evaluate(() =>
        JSON.stringify(window.__hs!.store.getState().atlas!.layout.rects.map((r) => [r.x, r.y, r.w, r.h])));
    await expect.poll(rectCount.bind(null, page)).toBeGreaterThan(0);
    const before = await signature();
    await page.getByTestId('layout-seed').fill('7');
    await page.getByTestId('layout-seed').blur();
    await expect.poll(signature).not.toBe(before);
    await expect(page.getByTestId('proportion-issues')).toHaveText('0');
  });

  test('map tabs switch the active map', async ({ page }) => {
    await page.getByRole('tab', { name: 'IDs rect' }).click();
    await expect(page.getByRole('tab', { name: 'IDs rect' })).toHaveAttribute('data-state', 'active');
    await page.getByRole('tab', { name: 'Height' }).click();
    await expect(page.getByRole('tab', { name: 'Height' })).toHaveAttribute('data-state', 'active');
  });
});

test('exports Unity URP maps, hotspot.json and Anvil csv to a folder, and overwrites on re-export', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('folder-input').setInputFiles(SAMPLE_DIR);
  await expect(page.getByTestId('material-name')).toHaveText('bricks_wall_13');
  await page.waitForFunction(() => !!window.__hs?.store.getState().atlas);
  const rectTotal = await page.evaluate(() => window.__hs!.store.getState().atlas!.layout.rects.length);
  expect(rectTotal).toBeGreaterThan(0);

  const dir = join(tmpdir(), `hotspotter export ${Date.now()}`, 'out dir');
  await page.getByTestId('export-open').click();
  await page.getByTestId('export-dir').fill(dir);
  await page.getByTestId('export-preset').click();
  await page.getByRole('option', { name: 'Unity URP' }).click();
  await page.getByTestId('export-res').click();
  await page.getByRole('option', { name: '1024' }).click();

  const run = async () => {
    await page.getByTestId('export-run').click();
    await expect(page.getByTestId('export-done')).toBeVisible({ timeout: 60_000 });
  };
  await run();

  const names = ['BaseColor', 'Normal', 'MetallicSmoothness', 'Occlusion', 'Height'].map(
    (k) => `bricks_wall_13_${k}.png`,
  );
  for (const n of names) {
    const buf = readFileSync(join(dir, n));
    expect(buf.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect([buf.readUInt32BE(16), buf.readUInt32BE(20)]).toEqual([1024, 1024]);
  }
  const json = JSON.parse(readFileSync(join(dir, 'bricks_wall_13.hotspot.json'), 'utf8'));
  expect(json.rects).toHaveLength(rectTotal);
  expect(json.maps).toEqual(names);
  expect(existsSync(join(dir, 'bricks_wall_13.anvil.csv'))).toBe(true);

  const listing = readdirSync(dir).sort();
  expect(listing).toHaveLength(7);
  await run();
  expect(readdirSync(dir).sort()).toEqual(listing);
});

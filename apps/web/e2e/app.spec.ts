import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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

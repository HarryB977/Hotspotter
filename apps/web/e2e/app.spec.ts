import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
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

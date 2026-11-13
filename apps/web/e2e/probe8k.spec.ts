import { test, expect } from '@playwright/test';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Opt-in probe (HS_PROBE_8K=1): exports bricks wall 13 at 8192 through the dialog and reports how it ends — done, an
// export error, or a lost GPU device with its reason (out of video memory, a driver reset). Slow and heavy (several
// GB of RAM and VRAM), so it never runs by default.
const SAMPLE_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../samples/pbr/bricks wall 13');

test.skip(process.env.HS_PROBE_8K !== '1', 'set HS_PROBE_8K=1 to run the 8192 export probe');
test.skip(!existsSync(SAMPLE_DIR), 'samples/pbr/bricks wall 13 not present');

test('8192 export probe', async ({ page }) => {
  test.setTimeout(900_000);
  const gpuLog: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || /GPU|device|WebGPU/i.test(m.text())) gpuLog.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('crash', () => gpuLog.push('[page] renderer crashed (likely out of RAM)'));

  await page.goto('/');
  await page.getByTestId('folder-input').setInputFiles(SAMPLE_DIR);
  await expect(page.getByTestId('material-name')).toHaveValue('bricks_wall_13');
  await page.waitForFunction(() => !!window.__hs?.store.getState().atlas && !!window.__hs.store.getState().structure);
  const adapter = await page.evaluate(() => window.__hs!.store.getState().gpu!.adapterInfo);

  const dir = join(tmpdir(), `hotspotter probe8k ${Date.now()}`);
  await page.getByTestId('export-open').click();
  await page.getByTestId('export-dir').fill(dir);
  await page.getByTestId('export-res').click();
  await page.getByRole('option', { name: '8192' }).click();
  const t0 = Date.now();
  await page.getByTestId('export-run').click();

  const end = page.locator('[data-testid="export-done"], [data-testid="export-error"], [data-testid="webgpu-error"]');
  let outcome = 'timeout';
  let text = '';
  try {
    await end.first().waitFor({ timeout: 840_000 });
    outcome = (await end.first().getAttribute('data-testid')) ?? 'unknown';
    text = (await end.first().innerText()).trim();
  } catch {
    text = 'no result within 14 min';
  }
  const seconds = Math.round((Date.now() - t0) / 1000);
  const files = existsSync(dir) ? readdirSync(dir).map((f) => `${f} ${Math.round(statSync(join(dir, f)).size / 1e6)} MB`) : [];
  const report = [
    `adapter: ${adapter}`, `outcome: ${outcome} after ${seconds} s`, `message: ${text}`,
    `files (${files.length}): ${files.join(', ')}`, ...gpuLog.slice(-20),
  ].join('\n');
  console.log(`--- 8192 probe ---\n${report}`);
  test.info().annotations.push({ type: '8192 probe', description: report });
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });

  expect(outcome, report).toBe('export-done');
});

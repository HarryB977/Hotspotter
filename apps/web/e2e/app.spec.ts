import { test, expect } from '@playwright/test';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { selectLayer } from './helpers';

const SAMPLE_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../samples/pbr/bricks wall 13');

test.skip(!existsSync(SAMPLE_DIR), 'samples/pbr/bricks wall 13 not present');

test('loads with title and imports the bricks wall 13 folder', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Hotspotter');
  await expect(page.getByTestId('webgpu-error')).toHaveCount(0);

  // A webkitdirectory input takes the directory itself.
  await page.getByTestId('folder-input').setInputFiles(SAMPLE_DIR);

  await expect(page.getByTestId('material-name')).toHaveValue('bricks_wall_13');
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

test('files without a shared prefix take the folder name, and the name is editable and sanitized', async ({ page }, testInfo) => {
  const dir = testInfo.outputPath('Old Planks');
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(SAMPLE_DIR, 'bricks_wall_13_basecolor_1k.png'), join(dir, 'basecolor.png'));

  await page.goto('/');
  await page.getByTestId('folder-input').setInputFiles(dir);
  const name = page.getByTestId('material-name');
  await expect(name).toHaveValue('Old Planks');

  await name.fill('my:wall?');
  await name.press('Enter');
  await expect(name).toHaveValue('mywall');
  await expect.poll(() => page.evaluate(() => window.__hs!.store.getState().material?.settings.name)).toBe('mywall');
});

test('a lost GPU device shows its reason in Spanish instead of hanging', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__hs?.store.getState().gpu);
  await page.evaluate(() => window.__hs!.store.getState().gpu!.device.destroy());
  await expect(page.getByTestId('webgpu-error')).toContainText('Se perdió la conexión con la GPU (el dispositivo se cerró)');
  // A later initGpu (every import calls it) keeps the error.
  await page.evaluate(() => window.__hs!.store.getState().initGpu());
  await expect(page.getByTestId('webgpu-error')).toContainText('Se perdió la conexión con la GPU');
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
    await expect(page.getByTestId('material-name')).toHaveValue('bricks_wall_13');
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
    await selectLayer(page, 'layout');
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

  test('the Pila lists the 7 layers and the selected one drives the inspector', async ({ page }) => {
    await page.waitForFunction(() => !!window.__hs?.store.getState().doc);
    const rows = page.getByTestId('stack-row');
    await expect(rows).toHaveCount(7);
    await expect(rows).toHaveText(['Material', 'Estructura', 'Layout', 'Colocación', 'Desgaste', 'Suciedad', 'Salida']);
    // Wear is selected after an import.
    await expect(page.getByTestId('wear-section')).toBeVisible();
    await expect(page.getByTestId('dirt-section')).toHaveCount(0);
    await page.getByTestId('stack-row').filter({ hasText: 'Suciedad' }).click({ position: { x: 6, y: 6 } });
    await expect(page.getByTestId('dirt-section')).toBeVisible();
    await expect(page.getByLabel('Escorrentía', { exact: true })).toBeVisible();
    await expect(page.getByTestId('wear-section')).toHaveCount(0);
    await expect(page.getByLabel('Intensidad', { exact: true })).toHaveCount(0);
  });

  test('ArrowDown in the Pila moves the selection from Desgaste to Suciedad', async ({ page }) => {
    await selectLayer(page, 'wear');
    await page.keyboard.press('ArrowDown');
    const dirt = page.locator('[data-testid="stack-row"][data-layer="dirt"]');
    await expect(dirt).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('dirt-section')).toBeVisible();
    await page.keyboard.press('ArrowUp');
    await expect(page.getByTestId('wear-section')).toBeVisible();
  });

  test('the switch in the Desgaste row turns the wear off', async ({ page }) => {
    await page.waitForFunction(() => !!window.__hs?.store.getState().doc);
    const enabled = () => page.evaluate(() =>
      (window.__hs!.store.getState().doc!.nodes.find((n) => n.id === 'wear')!.params as { enabled: boolean }).enabled);
    expect(await enabled()).toBe(true);
    const sw = page.locator('[data-testid="stack-row"][data-layer="wear"]').getByRole('switch');
    await sw.click();
    await expect.poll(enabled).toBe(false);
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('wear-enabled')).toHaveAttribute('aria-checked', 'false');
  });

  test('a branched graph shows the single disabled row Grafo personalizado', async ({ page }) => {
    await page.waitForFunction(() => !!window.__hs?.store.getState().doc);
    await page.evaluate(() => {
      const s = window.__hs!.store.getState();
      const d = s.doc!;
      s.setDoc({ ...d, edges: [...d.edges, { from: 'material', to: 'output', port: 'extra' }] });
    });
    const rows = page.getByTestId('stack-row');
    await expect(rows).toHaveCount(1);
    await expect(rows).toHaveText('Grafo personalizado');
    await expect(rows).toHaveAttribute('aria-disabled', 'true');
  });

  test('map tabs switch the active map', async ({ page }) => {
    await page.getByRole('tab', { name: 'IDs rect' }).click();
    await expect(page.getByRole('tab', { name: 'IDs rect' })).toHaveAttribute('data-state', 'active');
    await page.getByRole('tab', { name: 'Height' }).click();
    await expect(page.getByRole('tab', { name: 'Height' })).toHaveAttribute('data-state', 'active');
  });
});

/** Decodes an 8-bit RGBA, filter-0 PNG as written by encodePngRgba8. */
function decodeRgbaPng(buf: Buffer): { w: number; h: number; data: Buffer } {
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const idat: Buffer[] = [];
  for (let o = 8; o < buf.length; ) {
    const len = buf.readUInt32BE(o);
    if (buf.toString('latin1', o + 4, o + 8) === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) raw.copy(data, y * w * 4, y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1));
  return { w, h, data };
}

test('exports Unity URP maps, hotspot.json and Anvil csv to a folder, and overwrites on re-export', async ({ page }) => {
  // Import, analysis, the checks and two exports (a known load timeout at the default 30 s).
  test.setTimeout(120_000);
  await page.goto('/');
  await page.getByTestId('folder-input').setInputFiles(SAMPLE_DIR);
  await expect(page.getByTestId('material-name')).toHaveValue('bricks_wall_13');
  await page.waitForFunction(() => !!window.__hs?.store.getState().atlas);
  const rectTotal = await page.evaluate(() => window.__hs!.store.getState().atlas!.layout.rects.length);
  expect(rectTotal).toBeGreaterThan(0);

  const dir = join(tmpdir(), `hotspotter export ${Date.now()}`, 'out dir');
  await page.getByTestId('export-open').click();
  // Default dirt has no runoff (user decision 2026-11-13): no rotation warning.
  await expect(page.getByTestId('export-run')).toBeVisible();
  await expect(page.getByTestId('export-runoff-warning')).toHaveCount(0);
  await page.getByTestId('export-dir').fill(dir);
  await page.getByTestId('export-preset').click();
  await page.getByRole('option', { name: 'Unity URP' }).click();
  await page.getByTestId('export-res').click();
  await page.getByRole('option', { name: '1024' }).click();
  // One resolution: the dialog writes the output node, which the Checks panel reads.
  await expect.poll(() => page.evaluate(() => {
    const o = window.__hs!.store.getState().doc!.nodes.find((n) => n.type === 'output')!;
    return (o.params as { resolutionPx: number }).resolutionPx;
  })).toBe(1024);

  const run = async () => {
    await page.getByTestId('export-run').click();
    await expect(page.getByTestId('export-done')).toBeVisible({ timeout: 60_000 });
  };
  await run();
  // The checks ran at the export resolution before the export, and their warnings did not block it.
  await expect(page.getByTestId('export-checks').getByTestId('export-check-row')).toHaveCount(6);

  const names = ['BaseColor', 'Normal', 'MetallicSmoothness', 'Occlusion', 'Height', 'WearMask', 'RectID'].map(
    (k) => `bricks_wall_13_${k}.png`,
  );
  for (const n of names) {
    const buf = readFileSync(join(dir, n));
    expect(buf.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect([buf.readUInt32BE(16), buf.readUInt32BE(20)]).toEqual([1024, 1024]);
  }
  const wm = decodeRgbaPng(readFileSync(join(dir, 'bricks_wall_13_WearMask.png')));
  // Not uniform: worn and intact pixels (the 6 mm band is under a pixel at 1024, so few grey levels in between).
  let worn = 0, intact = 0;
  for (let i = 0; i < wm.data.length; i += 4) {
    if (wm.data[i] > 128) worn++;
    else if (wm.data[i] === 0) intact++;
  }
  expect(Math.min(worn, intact)).toBeGreaterThan(1000);
  // R must hold metallic untouched where smoothness (A) < 255; compare with a fresh readback of the preview atlas.
  const ms = decodeRgbaPng(readFileSync(join(dir, 'bricks_wall_13_MetallicSmoothness.png')));
  const metalRef = await page.evaluate(async () => {
    const hs = window.__hs!;
    const { data } = await hs.engine.readbackRgba8(hs.store.getState().gpu!, hs.lastAtlas!.metallic);
    return { size: Math.sqrt(data.length / 4), r: Array.from(data.filter((_, i) => i % 4 === 0)) };
  });
  let partial = 0;
  let nonZero = 0;
  for (let i = 0; i < ms.data.length; i += 4) {
    if (ms.data[i + 3] < 255) partial++;
    if (ms.data[i] > 0) nonZero++;
  }
  expect(partial).toBeGreaterThan(0);
  expect(ms.w).toBe(1024);
  expect(metalRef.size).toBe(1024);
  // Same size as the preview (1024); bricks metallic is uniform, so R must match exactly even though
  // the export layout is resolved at 1024 px and the preview layout at the 4096 px reference.
  for (let i = 0; i < metalRef.r.length; i++) {
    if (ms.data[i * 4 + 3] < 255 && ms.data[i * 4] !== metalRef.r[i]) {
      throw new Error(`metallic R differs at pixel ${i}: ${ms.data[i * 4]} vs ${metalRef.r[i]}`);
    }
  }
  expect(nonZero > 0 || metalRef.r.every((v) => v === 0)).toBe(true);

  const json = JSON.parse(readFileSync(join(dir, 'bricks_wall_13.hotspot.json'), 'utf8'));
  expect(json.rects).toHaveLength(rectTotal);
  // The layout is resolved at the export resolution, so px metadata matches the 1024 maps.
  expect(json.atlas.widthPx).toBe(1024);
  expect(json.maps).toEqual(names);
  expect(json.wear.family).toBe('brittle');
  expect(typeof json.wear.seed).toBe('number');
  expect(json.checks).toHaveLength(6);
  expect(json.checks.map((c: { id: string }) => c.id)).toEqual(
    ['coverage', 'islands', 'normal', 'proportions', 'bleed', 'substrate'],
  );
  // No runoff by default: mirroring follows the layout in hotspot.json and in Anvil's "Can mirror".
  const mirrors = await page.evaluate(() =>
    window.__hs!.core.composeInputsFromDoc(window.__hs!.store.getState().doc!, 1024).layout.rects
      .map((r) => [r.allowMirrorX, r.allowMirrorY]));
  expect(json.rects.map((r: { allowMirrorX: boolean; allowMirrorY: boolean }) => [r.allowMirrorX, r.allowMirrorY]))
    .toEqual(mirrors);
  // The v0.1 presets set no mirror flags, so this only shows nothing is forced; core export.test covers the flags.
  const csv = readFileSync(join(dir, 'bricks_wall_13.anvil.csv'), 'utf8').split(String.fromCharCode(13, 10));
  expect(csv[1].split(',').slice(6, 8)).toEqual(['Can mirror', 'Mirror X ok']);
  csv.slice(2).forEach((l, i) => {
    expect(l.split(',')[6]).toBe(mirrors[i][0] || mirrors[i][1] ? 'yes' : 'no');
    expect(l.split(',')[7]).toBe(json.rects[i].allowMirrorX ? 'yes' : 'no');
  });

  // _RectID: the view's hash colour of each rect at its centre.
  const ids = decodeRgbaPng(readFileSync(join(dir, 'bricks_wall_13_RectID.png')));
  const colours = await page.evaluate((n) => Array.from({ length: n + 1 }, (_, i) => window.__hs!.core.rectIdRgb(i)), rectTotal);
  json.rects.forEach((r: { px: { x: number; y: number; w: number; h: number } }, i: number) => {
    const o = (Math.floor(r.px.y + r.px.h / 2) * 1024 + Math.floor(r.px.x + r.px.w / 2)) * 4;
    expect(Array.from(ids.data.subarray(o, o + 4))).toEqual([...colours[i + 1], 255]);
  });

  const listing = readdirSync(dir).sort();
  expect(listing).toHaveLength(9);
  await run();
  expect(readdirSync(dir).sort()).toEqual(listing);

  // A reopened dialog shows no summary or result of the previous export.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('export-run')).toBeHidden();
  await page.getByTestId('export-open').click();
  await expect(page.getByTestId('export-run')).toBeVisible();
  await expect(page.getByTestId('export-checks')).toHaveCount(0);
  await expect(page.getByTestId('export-done')).toHaveCount(0);
});

test('the export dialog blocks a resolution over the GPU buffer limit, with a reason (R39)', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.getByTestId('folder-input').setInputFiles(SAMPLE_DIR);
  await page.waitForFunction(() => !!window.__hs?.store.getState().atlas);
  // A device that only allows 128 MiB buffers: 4096 (64 MiB per map) fits, 8192 (256 MiB) does not.
  await page.evaluate(() => {
    const limits = { maxBufferSize: 128 * 2 ** 20, maxTextureDimension2D: 8192 };
    Object.defineProperty(GPUDevice.prototype, 'limits', { get: () => limits, configurable: true });
    window.__hs!.store.getState().updateNode<'output'>('output', { resolutionPx: 4096 });
  });
  await page.getByTestId('export-open').click();
  await page.getByTestId('export-dir').fill('C:\\unused');
  await expect(page.getByTestId('export-too-big')).toHaveCount(0);
  await expect(page.getByTestId('export-run')).toBeEnabled();
  await page.getByTestId('export-res').click();
  await expect(page.getByRole('option', { name: '8192' })).toHaveAttribute('data-disabled', '');
  await expect(page.getByRole('option', { name: '4096' })).not.toHaveAttribute('data-disabled');
  await page.keyboard.press('Escape');
  // A value already in the output node (e.g. from a saved project) is reported and blocks the export.
  await page.evaluate(() => window.__hs!.store.getState().updateNode<'output'>('output', { resolutionPx: 8192 }));
  // The 8192 warning names the video memory it takes with wear (docs/09 #46).
  await expect(page.getByTestId('export-warning')).toContainText('4–5 GB de memoria de vídeo');
  await expect(page.getByTestId('export-too-big')).toContainText('256 MiB');
  await expect(page.getByTestId('export-too-big')).toContainText('128 MiB');
  await expect(page.getByTestId('export-too-big')).toContainText('resolución menor');
  await expect(page.getByTestId('export-run')).toBeDisabled();
});

const WOOD_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../samples/pbr/wood planks 12');

test.describe('loose files and orientation (wood planks 12)', () => {
  test.skip(!existsSync(WOOD_DIR), 'samples/pbr/wood planks 12 not present');
  const wood = (n: string) => join(WOOD_DIR, `wood_planks_12_${n}_1k.png`);
  const mapCount = (page: import('@playwright/test').Page) => page.getByTestId('map-row').count();

  test('loose files create a material, add keeps the document, replace resets it', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('import-files').setInputFiles([wood('color'), wood('normal_gl')]);
    await expect(page.getByTestId('material-name')).toHaveValue('wood_planks_12');
    await expect(page.getByTestId('map-row')).toHaveCount(2);

    await page.waitForFunction(() => !!window.__hs?.store.getState().doc);
    await selectLayer(page, 'layout');
    await page.getByTestId('layout-preset').click();
    await page.getByRole('option', { name: 'Marcos' }).click();
    await page.evaluate(() => window.__hs!.store.getState().updateNode<'placement'>('placement', { variation: 0.8 }));
    const snapshot = () =>
      page.evaluate(() => {
        const d = window.__hs!.store.getState().doc!;
        const n = (id: string) => d.nodes.find((x) => x.id === id)!.params as Record<string, unknown>;
        return { preset: n('layout').preset, variation: n('placement').variation };
      });
    expect(await snapshot()).toEqual({ preset: 'frames', variation: 0.8 });

    await page.getByTestId('import-files').setInputFiles([wood('roughness')]);
    await page.getByTestId('import-add').click();
    await expect.poll(() => mapCount(page)).toBe(3);
    expect(await snapshot()).toEqual({ preset: 'frames', variation: 0.8 });
    await expect(page.getByTestId('import-error')).toHaveCount(0);

    await page.getByTestId('import-files').setInputFiles([wood('color'), wood('normal_gl')]);
    await page.getByTestId('import-replace').click();
    await expect.poll(() => mapCount(page)).toBe(2);
    expect(await snapshot()).not.toEqual({ preset: 'frames', variation: 0.8 });
  });

  test('cancelling the choice dialog changes nothing', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('import-files').setInputFiles([wood('color')]);
    await expect(page.getByTestId('map-row')).toHaveCount(1);
    await page.getByTestId('import-files').setInputFiles([wood('roughness')]);
    await expect(page.getByTestId('import-add')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('import-add')).toHaveCount(0);
    await expect(page.getByTestId('map-row')).toHaveCount(1);
  });

  test('longAxis orientation rotates only the tall rects of a frames layout', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('folder-input').setInputFiles(WOOD_DIR);
    await expect(page.getByTestId('material-name')).toHaveValue('wood_planks_12');
    await selectLayer(page, 'layout');
    await page.getByTestId('layout-preset').click();
    await page.getByRole('option', { name: 'Marcos' }).click();
    await page.getByTestId('orientation-rule').click();
    await page.getByRole('option', { name: 'Seguir el eje largo' }).click();

    await expect
      .poll(() =>
        page.evaluate(() => {
          const a = window.__hs!.store.getState().atlas;
          if (!a) return null;
          const rot = new Map(a.placements.map((p) => [p.rectId, p.rotate90]));
          const tall = a.layout.rects.filter((r) => r.h > r.w);
          const wide = a.layout.rects.filter((r) => r.w > r.h);
          return {
            tall: tall.length > 0 && tall.every((r) => rot.get(r.id) === true),
            wide: wide.every((r) => rot.get(r.id) === false),
          };
        }))
      .toEqual({ tall: true, wide: true });
  });
});

test.describe('add mode races and texture bookkeeping (wood planks 12)', () => {
  test.skip(!existsSync(WOOD_DIR), 'samples/pbr/wood planks 12 not present');

  test('add keeps the normal flag and untouched textures, and drops itself when a reassignment commits meanwhile', async ({ page }) => {
    const w = (n: string) => join(WOOD_DIR, `wood_planks_12_${n}_1k.png`);
    await page.goto('/');
    await page.getByTestId('import-files').setInputFiles([w('color'), w('normal_gl'), w('height')]);
    await expect(page.getByTestId('map-row')).toHaveCount(3);

    // Add roughness: normal flag stays, color texture object is untouched.
    await page.evaluate(() => {
      const gm = window.__hs!.store.getState().gpuMaterial!;
      (window as unknown as Record<string, unknown>).__before = gm.textures.baseColor;
    });
    await page.getByTestId('import-files').setInputFiles([w('roughness')]);
    await page.getByTestId('import-add').click();
    await expect(page.getByTestId('map-row')).toHaveCount(4);
    const kept = await page.evaluate(() => {
      const gm = window.__hs!.store.getState().gpuMaterial!;
      return { normal: gm.hasNormalMap, same: gm.textures.baseColor === (window as unknown as Record<string, unknown>).__before };
    });
    expect(kept).toEqual({ normal: true, same: true });

    // Race: an add (decoding) and a reassignment that commits first.
    const r = await page.evaluate(async (names) => {
      const store = window.__hs!.store;
      const files = await Promise.all(names.map(async (n) => {
        const res = await fetch(`/samples/pbr/wood%20planks%2012/${encodeURIComponent(n)}`);
        return new File([await res.blob()], n);
      }));
      // Hold the add's decode until the reassignment has committed.
      let release!: () => void;
      const gate = new Promise<void>((res) => { release = res; });
      let entered!: () => void;
      const inDecode = new Promise<void>((res) => { entered = res; });
      const orig = window.createImageBitmap.bind(window);
      window.createImageBitmap = (async (...a: Parameters<typeof orig>) => {
        entered();
        await gate;
        return orig(...a);
      }) as typeof window.createImageBitmap;
      const add = store.getState().importFiles(files, undefined, 'add');
      await inDecode;
      await store.getState().assignMap('wood_planks_12_height_1k.png', null);
      release();
      await add;
      window.createImageBitmap = orig;
      const s = store.getState();
      return { files: Object.keys(s.material!.settings.files).sort(), importing: s.importing, error: s.importError };
    }, ['wood_planks_12_ambient_occlusion_1k.png']);
    expect(r.error).toBe('La configuración cambió durante la importación; vuelve a añadir los archivos.');
    expect(r.importing).toBe(false);
    // The reassignment committed during the add's decode, so the add is discarded.
    expect(r.files).toEqual(['baseColor', 'normal', 'roughness']);
  });
});

const CONCRETE_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../samples/pbr/concrete wall 01');

/** 8-bit greyscale PNG of one constant value. */
function greyPng(w: number, h: number, v: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const raw = Buffer.alloc((w + 1) * h, v);
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0; // filter type 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test.describe('wear and dirt controls (bricks wall 13)', () => {
  test.skip(!existsSync(CONCRETE_DIR), 'samples/pbr/concrete wall 01 not present');
  // Import + structure analysis + several compositions per test.
  test.describe.configure({ timeout: 90_000 });

  type P = import('@playwright/test').Page;

  /** Waits until the shown atlas was composed from the current document, mask and substrate. */
  const settled = (page: P) =>
    page.waitForFunction(() => {
      const s = window.__hs?.store.getState();
      return !!s?.atlas && !!s.structure && !s.importing && s.atlas.doc === s.doc && s.atlas.mask === s.mask &&
        s.atlas.substrate === s.substrate;
    });

  const setField = async (page: P, label: string, value: string) => {
    const f = page.getByLabel(label, { exact: true });
    await f.fill(value);
    await f.blur();
    await settled(page);
  };

  /** Fraction of atlas pixels with wearMask > 0, and an FNV hash of the mask. */
  const wearStats = (page: P) =>
    page.evaluate(async () => {
      const hs = window.__hs!;
      const { data } = await hs.engine.readbackRgba8(hs.store.getState().gpu!, hs.lastAtlas!.wearMask);
      let n = 0;
      let h = 0x811c9dc5;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 0) n++;
        h = Math.imul(h ^ data[i], 0x01000193) >>> 0;
      }
      return { frac: n / (data.length / 4), hash: h };
    });

  const wearSeed = (page: P) =>
    page.evaluate(() =>
      (window.__hs!.store.getState().doc!.nodes.find((n) => n.id === 'wear')!.params as { seed: number }).seed);

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('folder-input').setInputFiles(SAMPLE_DIR);
    await expect(page.getByTestId('material-name')).toHaveValue('bricks_wall_13');
    await selectLayer(page, 'structure');
    await expect(page.getByTestId('structure-type')).toHaveText('Piezas');
    await selectLayer(page, 'wear');
    await settled(page);
  });

  test('the proposed family is shown, and a family picked by the user survives re-analysis', async ({ page }) => {
    await expect(page.getByTestId('wear-family')).toHaveText('Rotura frágil');
    // A family set without userSetFamily is replaced by the proposal on the next analysis.
    await page.evaluate(() => window.__hs!.store.getState().updateNode<'wear'>('wear', { family: 'erosion' }));
    await expect(page.getByTestId('wear-family')).toHaveText('Erosión');
    await page.evaluate(() => window.__hs!.store.getState().analyze());
    await expect(page.getByTestId('wear-family')).toHaveText('Rotura frágil');
    // Picked in the UI: kept by the next analysis.
    await page.getByTestId('wear-family').click();
    await page.getByRole('option', { name: 'Erosión' }).click();
    await selectLayer(page, 'structure');
    await page.getByTestId('structure-detect').click();
    await settled(page);
    await selectLayer(page, 'wear');
    await expect(page.getByTestId('wear-family')).toHaveText('Erosión');
    expect(await page.evaluate(() => {
      const w = window.__hs!.store.getState().doc!.nodes.find((n) => n.id === 'wear')!.params as { userSetFamily?: boolean };
      return w.userSetFamily;
    })).toBe(true);
  });

  test('intensity 1 wears more than 0.2, and the seed button changes the wear mask', async ({ page }) => {
    await setField(page, 'Intensidad', '0.2');
    const low = await wearStats(page);
    await setField(page, 'Intensidad', '1');
    const high = await wearStats(page);
    expect(high.frac).toBeGreaterThan(low.frac * 1.2);

    const seed = await wearSeed(page);
    await page.getByTestId('wear-reseed').click();
    await expect.poll(() => wearSeed(page)).not.toBe(seed);
    await settled(page);
    expect((await wearStats(page)).hash).not.toBe(high.hash);
  });

  test('a black mask leaves only the minimum rim', async ({ page }, testInfo) => {
    await selectLayer(page, 'output');
    await page.getByTestId('preview-res').click();
    await page.getByRole('option', { name: '2048' }).click();
    await selectLayer(page, 'wear');
    await setField(page, 'Intensidad', '1');
    /** Deepest wearMask pixel, in metres from its rect's outer edge. */
    const maxDepthM = () =>
      page.evaluate(async () => {
        const hs = window.__hs!;
        const s = hs.store.getState();
        const a = s.atlas!;
        const wm = (await hs.engine.readbackRgba8(s.gpu!, a.maps.wearMask)).data;
        const ids = await hs.engine.readbackRgba8(s.gpu!, a.maps.rectId);
        const rid = new Uint32Array(ids.data.buffer, ids.data.byteOffset, ids.data.byteLength / 4);
        const W = a.maps.wearMask.width;
        const k = W / a.layout.widthPx;
        const ppm = W / a.layout.worldWidthM;
        let max = 0;
        for (let i = 0; i < rid.length; i++) {
          if (rid[i] === 0 || wm[i * 4] === 0) continue;
          const r = a.layout.rects[rid[i] - 1];
          const x = (i % W) + 0.5;
          const y = Math.floor(i / W) + 0.5;
          const d = Math.min(x - r.x * k, (r.x + r.w) * k - x, y - r.y * k, (r.y + r.h) * k - y);
          max = Math.max(max, d / ppm);
        }
        return { max, ppm };
      });
    const before = await maxDepthM();

    mkdirSync(testInfo.outputPath(), { recursive: true });
    const png = testInfo.outputPath('black-mask.png');
    writeFileSync(png, greyPng(64, 64, 0));
    await page.getByTestId('wear-mask-input').setInputFiles(png);
    await expect(page.getByTestId('wear-mask-name')).toHaveText('black-mask.png');
    await settled(page);
    const after = await maxDepthM();

    // Rim: half the groove floor (6 mm) + 1.6 · minEdgeM (4 mm), plus 1.5 px of filtering.
    const bound = 0.003 + 1.6 * 0.004 + 1.5 / after.ppm;
    expect(before.max).toBeGreaterThan(bound * 1.5);
    expect(after.max).toBeGreaterThan(0);
    expect(after.max).toBeLessThanOrEqual(bound);

    // Inverted, the black mask doubles the damage instead.
    await page.getByLabel('Invertir', { exact: true }).check();
    await settled(page);
    expect((await maxDepthM()).max).toBeGreaterThan(bound * 1.5);

    await page.getByTestId('wear-mask-clear').click();
    await settled(page);
    expect((await maxDepthM()).max).toBeCloseTo(before.max, 6);
  });

  test('a second material revealed in the loss changes its colour', async ({ page }) => {
    await setField(page, 'Intensidad', '1');
    /** Mean base colour where the wear mask is nearly full. */
    const lossColour = () =>
      page.evaluate(async () => {
        const hs = window.__hs!;
        const s = hs.store.getState();
        const wm = (await hs.engine.readbackRgba8(s.gpu!, s.atlas!.maps.wearMask)).data;
        const bc = (await hs.engine.readbackRgba8(s.gpu!, s.atlas!.maps.baseColor)).data;
        const sum = [0, 0, 0];
        let n = 0;
        let hash = 0x811c9dc5;
        for (let i = 0; i < wm.length; i += 4) {
          if (wm[i] < 200) continue;
          for (let c = 0; c < 3; c++) {
            sum[c] += bc[i + c];
            hash = Math.imul(hash ^ bc[i + c], 0x01000193) >>> 0;
          }
          n++;
        }
        return { n, hash, rgb: sum.map((v) => v / Math.max(1, n)) };
      });
    await page.getByTestId('substrate-source').click();
    await page.getByRole('option', { name: 'Segundo material' }).click();
    await settled(page);
    const interior = await lossColour();
    expect(interior.n).toBeGreaterThan(100);

    await page.getByTestId('substrate-input').setInputFiles(readdirSync(CONCRETE_DIR).map((f) => join(CONCRETE_DIR, f)));
    await expect(page.getByTestId('substrate-name')).toHaveText('concrete_wall_01');
    await settled(page);
    const second = await lossColour();
    expect(second.n).toBe(interior.n);
    const diff = Math.max(...second.rgb.map((v, c) => Math.abs(v - interior.rgb[c])));
    expect(diff).toBeGreaterThan(8);

    // Its own tile size (R34): at 2 m the revealed colour changes, the loss itself does not.
    await setField(page, 'Tamaño (m) X', '2');
    await setField(page, 'Tamaño (m) Y', '2');
    expect(await page.evaluate(() => window.__hs!.store.getState().substrate!.gpu.settings.tileSizeM)).toEqual([2, 2]);
    const scaled = await lossColour();
    expect(scaled.n).toBe(second.n);
    expect(scaled.hash).not.toBe(second.hash);
  });

  test('replacing the material drops the mask and disables it', async ({ page }, testInfo) => {
    mkdirSync(testInfo.outputPath(), { recursive: true });
    const png = testInfo.outputPath('grey-mask.png');
    writeFileSync(png, greyPng(16, 16, 128));
    await page.getByTestId('wear-mask-input').setInputFiles(png);
    await expect(page.getByTestId('wear-mask-name')).toHaveText('grey-mask.png');
    await page.getByTestId('folder-input').setInputFiles(SAMPLE_DIR);
    await page.getByTestId('import-replace').click();
    await expect(page.getByTestId('wear-mask-name')).toHaveText('Sin máscara');
    await settled(page);
    expect(await page.evaluate(() => {
      const s = window.__hs!.store.getState();
      const w = s.doc!.nodes.find((n) => n.id === 'wear')!.params as { mask: { enabled: boolean } };
      return { mask: s.mask, enabled: w.mask.enabled };
    })).toEqual({ mask: null, enabled: false });
  });

  test('runoff 0 leaves the strips under the top edges untouched', async ({ page }) => {
    /** Red channel of a strip 1–10 cm below the top edge of every tall enough rect, central half of its width. */
    const strips = () =>
      page.evaluate(async () => {
        const hs = window.__hs!;
        const s = hs.store.getState();
        const a = s.atlas!;
        const bc = (await hs.engine.readbackRgba8(s.gpu!, a.maps.baseColor)).data;
        const W = a.maps.baseColor.width;
        const k = W / a.layout.widthPx;
        const ppm = W / a.layout.worldWidthM;
        const out: number[] = [];
        for (const r of a.layout.rects) {
          if (r.h * k < 0.12 * ppm) continue;
          const y0 = Math.ceil(r.y * k + 0.01 * ppm);
          const y1 = Math.floor(r.y * k + 0.1 * ppm);
          const x0 = Math.ceil((r.x + r.w * 0.25) * k);
          const x1 = Math.floor((r.x + r.w * 0.75) * k);
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out.push(bc[(y * W + x) * 4]);
        }
        return out;
      });
    const mean = (v: number[]) => v.reduce((p, q) => p + q, 0) / v.length;
    await selectLayer(page, 'dirt');
    await setField(page, 'Escorrentía', '1');
    const dirty = await strips();
    await setField(page, 'Escorrentía', '0');
    const clean = await strips();
    expect(clean.length).toBeGreaterThan(1000);
    expect(mean(clean)).toBeGreaterThan(mean(dirty) + 2);
    // Without runoff its length has no effect on the strips.
    await setField(page, 'Longitud (cm)', '10');
    expect(await strips()).toEqual(clean);
  });

  test('the export composes what the preview shows: runoff, a black mask and a second material (R34)', async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    // Preview and export at 1024 with the layout resolved at 1024 too: the same compose input, so the same bytes.
    await page.evaluate(() => window.__hs!.store.getState().updateNode<'output'>('output', { resolutionPx: 1024 }));
    await settled(page);
    const fnv = (d: Uint8Array) => {
      let h = 0x811c9dc5;
      for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 0x01000193) >>> 0;
      return h;
    };
    type Rect = { px: { x: number; y: number; w: number; h: number } };
    let n = 0;
    const exported = async () => {
      const dir = testInfo.outputPath(`export-${n++}`);
      await page.evaluate((d) => window.__hs!.exportProject({ dir: d, preset: 'unity-urp', resolutionPx: 1024 }), dir);
      const read = (k: string) => decodeRgbaPng(readFileSync(join(dir, `bricks_wall_13_${k}.png`)));
      const json = JSON.parse(readFileSync(join(dir, 'bricks_wall_13.hotspot.json'), 'utf8'));
      return { base: read('BaseColor'), wear: read('WearMask'), rects: json.rects as Rect[], ppm: json.atlas.pxPerMetre as number };
    };
    const previewHashes = () =>
      page.evaluate(async () => {
        const hs = window.__hs!;
        const s = hs.store.getState();
        const h = (d: Uint8Array) => {
          let x = 0x811c9dc5;
          for (let i = 0; i < d.length; i++) x = Math.imul(x ^ d[i], 0x01000193) >>> 0;
          return x;
        };
        return {
          base: h((await hs.engine.readbackRgba8(s.gpu!, s.atlas!.maps.baseColor)).data),
          wear: h((await hs.engine.readbackRgba8(s.gpu!, s.atlas!.maps.wearMask)).data),
        };
      });
    const expectParity = async (e: Awaited<ReturnType<typeof exported>>) => {
      expect({ base: fnv(e.base.data), wear: fnv(e.wear.data) }).toEqual(await previewHashes());
    };
    /** Mean red 1–10 cm below the top edge of every tall enough rect, central half of its width. */
    const topStrip = (e: Awaited<ReturnType<typeof exported>>) => {
      let sum = 0, cnt = 0;
      for (const { px: r } of e.rects) {
        if (r.h < 0.12 * e.ppm) continue;
        for (let y = Math.ceil(r.y + 0.01 * e.ppm); y < Math.floor(r.y + 0.1 * e.ppm); y++) {
          for (let x = Math.ceil(r.x + r.w * 0.25); x < Math.floor(r.x + r.w * 0.75); x++) {
            sum += e.base.data[(y * e.base.w + x) * 4];
            cnt++;
          }
        }
      }
      expect(cnt).toBeGreaterThan(1000);
      return sum / cnt;
    };
    /** Deepest wearMask pixel, in metres from its rect's outer edge. */
    const maxDepthM = (e: Awaited<ReturnType<typeof exported>>) => {
      let max = 0;
      for (const { px: r } of e.rects) {
        for (let y = r.y; y < r.y + r.h; y++) {
          for (let x = r.x; x < r.x + r.w; x++) {
            if (e.wear.data[(y * e.wear.w + x) * 4] === 0) continue;
            const d = Math.min(x + 0.5 - r.x, r.x + r.w - x - 0.5, y + 0.5 - r.y, r.y + r.h - y - 0.5);
            max = Math.max(max, d / e.ppm);
          }
        }
      }
      return max;
    };
    /** Mean base colour where the exported wear mask is nearly full. */
    const lossRgb = (e: Awaited<ReturnType<typeof exported>>) => {
      const sum = [0, 0, 0];
      let cnt = 0;
      for (let i = 0; i < e.wear.data.length; i += 4) {
        if (e.wear.data[i] < 200) continue;
        for (let c = 0; c < 3; c++) sum[c] += e.base.data[i + c];
        cnt++;
      }
      expect(cnt).toBeGreaterThan(100);
      return sum.map((v) => v / cnt);
    };

    // Runoff: the exported top strips darken.
    await selectLayer(page, 'dirt');
    await setField(page, 'Escorrentía', '1');
    const runoff = await exported();
    await expectParity(runoff);
    await setField(page, 'Escorrentía', '0');
    const clean = await exported();
    expect(topStrip(clean)).toBeGreaterThan(topStrip(runoff) + 2);

    // Black mask: nothing is lost beyond the rim in the exported wear mask.
    await selectLayer(page, 'wear');
    await setField(page, 'Intensidad', '1');
    const unmasked = await exported();
    mkdirSync(testInfo.outputPath(), { recursive: true });
    const png = testInfo.outputPath('black-mask.png');
    writeFileSync(png, greyPng(64, 64, 0));
    await page.getByTestId('wear-mask-input').setInputFiles(png);
    await expect(page.getByTestId('wear-mask-name')).toHaveText('black-mask.png');
    await settled(page);
    const masked = await exported();
    await expectParity(masked);
    // Rim: half the groove floor (6 mm) + 1.6 · minEdgeM (4 mm), plus 1.5 px of filtering.
    const bound = 0.003 + 1.6 * 0.004 + 1.5 / masked.ppm;
    expect(maxDepthM(unmasked)).toBeGreaterThan(bound);
    expect(maxDepthM(masked)).toBeGreaterThan(0);
    expect(maxDepthM(masked)).toBeLessThanOrEqual(bound);
    await page.getByTestId('wear-mask-clear').click();
    await settled(page);

    // Second material: the exported loss colour changes.
    await page.getByTestId('substrate-source').click();
    await page.getByRole('option', { name: 'Segundo material' }).click();
    await settled(page);
    const interior = await exported();
    await page.getByTestId('substrate-input').setInputFiles(readdirSync(CONCRETE_DIR).map((f) => join(CONCRETE_DIR, f)));
    await expect(page.getByTestId('substrate-name')).toHaveText('concrete_wall_01');
    await settled(page);
    const second = await exported();
    await expectParity(second);
    const a = lossRgb(interior), b = lossRgb(second);
    expect(Math.max(...a.map((v, c) => Math.abs(v - b[c])))).toBeGreaterThan(8);
  });

  /** FNV hashes of every composed map of the shown atlas, plus the sizes of the wear maps. */
  const atlasHashes = (page: P) =>
    page.evaluate(async () => {
      const hs = window.__hs!;
      const s = hs.store.getState();
      const m = s.atlas!.maps;
      const h = (d: Uint8Array) => {
        let x = 0x811c9dc5;
        for (let i = 0; i < d.length; i++) x = Math.imul(x ^ d[i], 0x01000193) >>> 0;
        return x;
      };
      const rgba = async (t: GPUTexture) => h((await hs.engine.readbackRgba8(s.gpu!, t)).data);
      const r32 = async (t: GPUTexture) => {
        const d = (await hs.engine.readbackR32(s.gpu!, t)).data;
        return h(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
      };
      return {
        baseColor: await rgba(m.baseColor), normal: await rgba(m.normal), roughness: await rgba(m.roughness),
        metallic: await rgba(m.metallic), ao: await rgba(m.ao), height: await r32(m.height),
        wearMask: await rgba(m.wearMask), sizes: [m.loss, m.border, m.wearMask].map((t) => [t.width, t.height]),
      };
    });

  const switchSection = async (page: P, id: 'wear' | 'dirt', on: boolean) => {
    const sw = page.getByTestId(`${id}-enabled`);
    await expect(sw).toHaveAttribute('title', /^Apagado, el atlas sale sin/);
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', String(on));
    await settled(page);
    // Off dims the section's fields.
    await expect(page.getByTestId(`${id}-section`).locator('[data-dimmed]')).toHaveCount(on ? 0 : 1);
  };

  test('wear off composes as without wear: 1 × 1 maps, black _WearMask, no wear in hotspot.json', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await setField(page, 'Intensidad', '1');
    const on = await atlasHashes(page);
    await switchSection(page, 'wear', false);
    const off = await atlasHashes(page);
    expect(off.sizes).toEqual([[1, 1], [1, 1], [1, 1]]);
    expect(off.baseColor).not.toBe(on.baseColor);
    // The in-run wear-null compose (R32e): the same input with no wear at all gives the same bytes.
    const nullHashes = await page.evaluate(async () => {
      const hs = window.__hs!;
      const s = hs.store.getState();
      const { layout, placements } = hs.core.composeInputsFromDoc(s.doc!);
      const dirt = s.doc!.nodes.find((n) => n.type === 'dirt')!.params as import('@hotspotter/core').DirtParams;
      const m = await hs.engine.composeAtlas(s.gpu!, {
        layout, material: s.gpuMaterial!, placements, resolutionPx: s.previewRes, structure: s.structure?.gpu,
        wear: undefined, dirt: dirt.enabled ? dirt : undefined, mask: s.mask?.texture,
        substrateMaterial: s.substrate?.gpu, grainAxis: s.structure?.result.grainAxis ?? null,
      });
      const h = (d: Uint8Array) => {
        let x = 0x811c9dc5;
        for (let i = 0; i < d.length; i++) x = Math.imul(x ^ d[i], 0x01000193) >>> 0;
        return x;
      };
      const rgba = async (t: GPUTexture) => h((await hs.engine.readbackRgba8(s.gpu!, t)).data);
      const hd = (await hs.engine.readbackR32(s.gpu!, m.height)).data;
      const out = {
        baseColor: await rgba(m.baseColor), normal: await rgba(m.normal), roughness: await rgba(m.roughness),
        metallic: await rgba(m.metallic), ao: await rgba(m.ao),
        height: h(new Uint8Array(hd.buffer, hd.byteOffset, hd.byteLength)),
        wearMask: await rgba(m.wearMask), sizes: [m.loss, m.border, m.wearMask].map((t) => [t.width, t.height]),
      };
      for (const t of Object.values(m)) {
        if (t && typeof (t as GPUTexture).destroy === 'function') (t as GPUTexture).destroy();
      }
      return out;
    });
    expect(off).toEqual(nullHashes);
    // Coverage and islands report the wear as off.
    await expect.poll(() => page.evaluate(() => {
      const s = window.__hs!.store.getState();
      if (!s.checks || s.checksPending) return null;
      return s.checks.results.filter((c) => c.id === 'coverage' || c.id === 'islands')
        .map((c) => [c.status, /desactivado/.test(c.message)]);
    }), { timeout: 30_000 }).toEqual([['ok', true], ['ok', true]]);

    const dir = testInfo.outputPath('wear-off');
    await page.evaluate((d) => window.__hs!.exportProject({ dir: d, preset: 'unity-urp', resolutionPx: 1024 }), dir);
    const wm = decodeRgbaPng(readFileSync(join(dir, 'bricks_wall_13_WearMask.png')));
    expect([wm.w, wm.h]).toEqual([1024, 1024]);
    for (let i = 0; i < wm.data.length; i += 4) {
      if (wm.data[i] !== 0 || wm.data[i + 3] !== 255) throw new Error(`_WearMask not black at pixel ${i / 4}`);
    }
    const json = JSON.parse(readFileSync(join(dir, 'bricks_wall_13.hotspot.json'), 'utf8'));
    expect(json).not.toHaveProperty('wear');

    // Back on: the wear returns unchanged.
    await switchSection(page, 'wear', true);
    expect(await atlasHashes(page)).toEqual(on);
  });

  test('dirt off drops cavity dirt and runoff, and mirroring follows the layout again', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await selectLayer(page, 'dirt');
    await setField(page, 'Escorrentía', '1');
    const dirty = await atlasHashes(page);
    await page.getByTestId('export-open').click();
    await expect(page.getByTestId('export-runoff-warning')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('export-run')).toBeHidden();

    await switchSection(page, 'dirt', false);
    const off = await atlasHashes(page);
    expect(off.baseColor).not.toBe(dirty.baseColor);
    // runoff > 0 in the params has no effect while the section is off.
    await setField(page, 'Escorrentía', '0');
    expect(await atlasHashes(page)).toEqual(off);
    await setField(page, 'Escorrentía', '1');
    expect(await atlasHashes(page)).toEqual(off);

    await page.getByTestId('export-open').click();
    await expect(page.getByTestId('export-run')).toBeVisible();
    await expect(page.getByTestId('export-runoff-warning')).toHaveCount(0);
    await page.keyboard.press('Escape');

    const dir = testInfo.outputPath('dirt-off');
    await page.evaluate((d) => window.__hs!.exportProject({ dir: d, preset: 'unity-urp', resolutionPx: 1024 }), dir);
    const json = JSON.parse(readFileSync(join(dir, 'bricks_wall_13.hotspot.json'), 'utf8'));
    const mirrors = await page.evaluate(() =>
      window.__hs!.core.composeInputsFromDoc(window.__hs!.store.getState().doc!, 1024).layout.rects
        .map((r) => [r.allowMirrorX, r.allowMirrorY]));
    // The v0.1 presets set no mirror flags; core export.test covers runoff false keeping them.
    expect(json.rects.map((r: { allowMirrorX: boolean; allowMirrorY: boolean }) => [r.allowMirrorX, r.allowMirrorY]))
      .toEqual(mirrors);
    const csv = readFileSync(join(dir, 'bricks_wall_13.anvil.csv'), 'utf8').split(String.fromCharCode(13, 10));
    csv.slice(2).forEach((l, i) => expect(l.split(',')[6]).toBe(mirrors[i][0] || mirrors[i][1] ? 'yes' : 'no'));
  });

  test('the Desgaste tab shows the wear mask', async ({ page }) => {
    // Big enough that the atlas is drawn at least 1:1, so every map texel has its own screen pixels.
    await page.setViewportSize({ width: 1920, height: 1400 });
    await setField(page, 'Intensidad', '1');
    await page.getByTestId('atlas-overlay').evaluate((el) => { (el as unknown as HTMLElement).style.visibility = 'hidden'; });
    /** Screenshot of the canvas, split by the wearMask value at the texel each screen pixel shows (red channel). */
    const shot = async () => {
      const png = (await page.getByTestId('atlas-canvas').screenshot()).toString('base64');
      return page.evaluate(async (b64) => {
        const hs = window.__hs!;
        const s = hs.store.getState();
        const wm = (await hs.engine.readbackRgba8(s.gpu!, s.atlas!.maps.wearMask)).data;
        const W = s.atlas!.maps.wearMask.width;
        const H = s.atlas!.maps.wearMask.height;
        const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
        const g = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d')!;
        g.drawImage(bmp, 0, 0);
        const px = g.getImageData(0, 0, bmp.width, bmp.height).data;
        let hi = 0, nHi = 0, lo = 0, nLo = 0, all = 0;
        for (let y = 0; y < bmp.height; y++) {
          for (let x = 0; x < bmp.width; x++) {
            const v = px[(y * bmp.width + x) * 4];
            all += v;
            const tx = Math.floor(((x + 0.5) / bmp.width) * W);
            const ty = Math.floor(((y + 0.5) / bmp.height) * H);
            const m = wm[(ty * W + tx) * 4];
            if (m > 128) { hi += v; nHi++; } else if (m === 0) { lo += v; nLo++; }
          }
        }
        return { w: bmp.width, hi: hi / Math.max(1, nHi), nHi, lo: lo / Math.max(1, nLo), mean: all / (bmp.width * bmp.height) };
      }, png);
    };
    await page.getByRole('tab', { name: 'Desgaste' }).click();
    await expect(page.getByRole('tab', { name: 'Desgaste' })).toHaveAttribute('data-state', 'active');
    expect(await page.evaluate(() => window.__hs!.store.getState().activeMap)).toBe('wearMask');
    const wear = await shot();
    expect(wear.w).toBeGreaterThanOrEqual(1024);
    expect(wear.nHi).toBeGreaterThan(1000);
    expect(wear.hi).toBeGreaterThan(100);
    expect(wear.lo).toBeLessThan(20);

    await page.getByRole('tab', { name: 'BaseColor' }).click();
    const base = await shot();
    expect(base.mean).toBeGreaterThan(wear.mean + 30);
  });
});

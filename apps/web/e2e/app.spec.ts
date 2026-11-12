import { test, expect } from '@playwright/test';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

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
  await page.goto('/');
  await page.getByTestId('folder-input').setInputFiles(SAMPLE_DIR);
  await expect(page.getByTestId('material-name')).toHaveValue('bricks_wall_13');
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
  expect(existsSync(join(dir, 'bricks_wall_13.anvil.csv'))).toBe(true);

  const listing = readdirSync(dir).sort();
  expect(listing).toHaveLength(7);
  await run();
  expect(readdirSync(dir).sort()).toEqual(listing);
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

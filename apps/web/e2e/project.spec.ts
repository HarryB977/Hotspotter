import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const BRICKS = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../samples/pbr/bricks wall 13');
const CONCRETE = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../samples/pbr/concrete wall 01');

test.skip(!existsSync(BRICKS) || !existsSync(CONCRETE), 'samples bricks wall 13 / concrete wall 01 not present');
// Import, analysis, several compositions, a save and an open per test.
test.describe.configure({ timeout: 120_000 });

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
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h, v);
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Waits until the shown atlas was composed from the current document, material, mask and substrate. */
const settled = (page: Page) =>
  page.waitForFunction(() => {
    const s = window.__hs?.store.getState();
    return !!s?.atlas && !!s.structure && !s.importing && s.analysisIdle && s.atlas.doc === s.doc &&
      s.atlas.gpuMaterial === s.gpuMaterial && s.atlas.mask === s.mask && s.atlas.substrate === s.substrate &&
      s.atlas.resolutionPx === s.previewRes;
  });

const setField = async (page: Page, label: string, value: string) => {
  const f = page.getByLabel(label, { exact: true });
  await f.fill(value);
  await f.blur();
  await settled(page);
};

/** Saved-session fingerprint: the document, mask name, substrate tile and an FNV hash of the wearMask. */
const snapshot = (page: Page) =>
  page.evaluate(async () => {
    const hs = window.__hs!;
    const s = hs.store.getState();
    const { data } = await hs.engine.readbackRgba8(s.gpu!, s.atlas!.maps.wearMask);
    let h = 0x811c9dc5;
    for (let i = 0; i < data.length; i += 4) h = Math.imul(h ^ data[i], 0x01000193) >>> 0;
    return {
      doc: JSON.parse(JSON.stringify(s.doc)) as unknown,
      material: s.material!.settings.name,
      mask: s.mask?.name ?? null,
      substrateName: s.substrate?.name ?? null,
      substrateTile: s.substrate?.gpu.settings.tileSizeM ?? null,
      wearHash: h,
    };
  });

const dirty = (page: Page) => page.evaluate(() => window.__hs!.store.getState().dirty);

/** Whether a beforeunload listener cancels the unload (i.e. the page asks before closing). */
const asksBeforeUnload = (page: Page) =>
  page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })));

/** Imports bricks wall 13, sets wear 0.8, a black mask and concrete wall 01 as second set at 2 × 2 m. */
async function buildSession(page: Page, dir: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('folder-input').setInputFiles(BRICKS);
  await expect(page.getByTestId('material-name')).toHaveValue('bricks_wall_13');
  await expect(page.getByTestId('structure-type')).toHaveText('Piezas');
  await settled(page);
  await setField(page, 'Intensidad', '0.8');
  const png = join(dir, 'black-mask.png');
  writeFileSync(png, greyPng(64, 64, 0));
  await page.getByTestId('wear-mask-input').setInputFiles(png);
  await expect(page.getByTestId('wear-mask-name')).toHaveText('black-mask.png');
  await page.getByTestId('substrate-source').click();
  await page.getByRole('option', { name: 'Segundo material' }).click();
  await page.getByTestId('substrate-input').setInputFiles(readdirSync(CONCRETE).map((f) => join(CONCRETE, f)));
  await expect(page.getByTestId('substrate-name')).toHaveText('concrete_wall_01');
  await setField(page, 'Tamaño (m) X', '2');
  await setField(page, 'Tamaño (m) Y', '2');
  await settled(page);
}

/** Saves through Archivo > Guardar como… and returns the written path. */
async function saveAs(page: Page, dir: string, name: string): Promise<string> {
  await page.getByTestId('file-menu').click();
  await page.getByTestId('file-save-as').click();
  await page.getByTestId('save-as-dir').fill(dir);
  await page.getByTestId('save-as-name').fill(name);
  await page.getByTestId('save-as-run').click();
  await expect(page.getByTestId('save-as-dialog')).toHaveCount(0);
  const path = join(dir, name.endsWith('.hsp') ? name : `${name}.hsp`);
  expect(existsSync(path)).toBe(true);
  return path;
}

test('Guardar como writes one .hsp; Nuevo asks only when dirty; Abrir restores the session', async ({ page }, testInfo) => {
  const dir = testInfo.outputPath();
  mkdirSync(dir, { recursive: true });
  await buildSession(page, dir);
  expect(await dirty(page)).toBe(true);
  await expect(page.getByTestId('project-name')).toHaveText('Sin título •');
  const saved = await snapshot(page);
  expect(saved.mask).toBe('black-mask.png');
  expect(saved.substrateTile).toEqual([2, 2]);

  const out = join(dir, 'out');
  const path = await saveAs(page, out, 'muro');
  expect(readdirSync(out)).toEqual(['muro.hsp']);
  expect(await dirty(page)).toBe(false);
  await expect(page.getByTestId('project-name')).toHaveText('muro');
  await expect(page).toHaveTitle('muro — Hotspotter');

  // Clean: Nuevo empties the project without asking.
  await page.getByTestId('file-menu').click();
  await page.getByTestId('file-new').click();
  await expect(page.getByTestId('unsaved-dialog')).toHaveCount(0);
  expect(await page.evaluate(() => window.__hs!.store.getState().doc)).toBeNull();
  await expect(page.getByTestId('project-name')).toHaveText('Sin proyecto');

  // Dirty: Nuevo asks; Cancelar keeps the project.
  await page.getByTestId('folder-input').setInputFiles(BRICKS);
  await expect(page.getByTestId('material-name')).toHaveValue('bricks_wall_13');
  await settled(page);
  expect(await dirty(page)).toBe(true);
  await page.getByTestId('file-menu').click();
  await page.getByTestId('file-new').click();
  await expect(page.getByTestId('unsaved-dialog')).toBeVisible();
  await expect(page.getByTestId('unsaved-dialog')).toContainText('Hay cambios sin guardar');
  await page.getByTestId('unsaved-cancel').click();
  await expect(page.getByTestId('unsaved-dialog')).toHaveCount(0);
  expect(await page.evaluate(() => window.__hs!.store.getState().doc !== null)).toBe(true);

  // Abrir while dirty asks too; Descartar opens the file.
  await page.getByTestId('project-open-input').setInputFiles(path);
  await expect(page.getByTestId('unsaved-dialog')).toBeVisible();
  await page.getByTestId('unsaved-discard').click();
  await expect(page.getByTestId('project-name')).toHaveText('muro');
  await settled(page);
  const opened = await snapshot(page);
  expect(opened).toEqual(saved);
  expect(await dirty(page)).toBe(false);
  await expect(page.getByTestId('wear-mask-name')).toHaveText('black-mask.png');
  await expect(page.getByTestId('substrate-name')).toHaveText('concrete_wall_01');
});

test('a corrupted .hsp keeps the current project and shows the error', async ({ page }, testInfo) => {
  const dir = testInfo.outputPath();
  mkdirSync(dir, { recursive: true });
  await buildSession(page, dir);
  const path = await saveAs(page, dir, 'bueno.hsp');
  const before = await snapshot(page);
  const ids = () => page.evaluate(() => {
    const s = window.__hs!.store.getState();
    const w = window as unknown as { __keep?: object[] };
    return w.__keep!.every((o, i) => o === [s.doc, s.gpuMaterial, s.mask, s.substrate, s.structure][i]);
  });
  await page.evaluate(() => {
    const s = window.__hs!.store.getState();
    (window as unknown as { __keep?: object[] }).__keep = [s.doc!, s.gpuMaterial!, s.mask!, s.substrate!, s.structure!];
  });

  // A flipped byte in the middle (inside an image): the CRC check fails.
  const bytes = readFileSync(path);
  bytes[bytes.length >> 1] ^= 0xff;
  const bad = join(dir, 'roto.hsp');
  writeFileSync(bad, bytes);
  await page.getByTestId('project-open-input').setInputFiles(bad);
  await expect(page.getByTestId('project-error')).toContainText('dañado');
  expect(await ids()).toBe(true);

  // Not a zip at all.
  const junk = join(dir, 'basura.hsp');
  writeFileSync(junk, 'esto no es un proyecto');
  await page.getByTestId('project-open-input').setInputFiles(junk);
  await expect(page.getByTestId('project-error')).toBeVisible();
  expect(await ids()).toBe(true);
  await expect(page.getByTestId('project-name')).toHaveText('bueno');
  await settled(page);
  expect(await snapshot(page)).toEqual(before);
});

test('opening while a composition is in flight keeps only the opened project and destroys nothing in use', async ({ page }, testInfo) => {
  const dir = testInfo.outputPath();
  mkdirSync(dir, { recursive: true });
  const gpuErrors: string[] = [];
  page.on('console', (m) => {
    if (/destroyed|invalid/i.test(m.text())) gpuErrors.push(m.text());
  });
  page.on('pageerror', (e) => gpuErrors.push(e.message));
  await buildSession(page, dir);
  const path = await saveAs(page, dir, 'vuelo.hsp');
  const saved = await snapshot(page);

  // Change the session so the opened document differs from the current one.
  await setField(page, 'Intensidad', '0.3');
  await page.evaluate(() => {
    const input = Object.assign(document.createElement('input'), { type: 'file', id: 'hsp-pick' });
    document.body.appendChild(input);
  });
  await page.setInputFiles('#hsp-pick', path);
  const r = await page.evaluate(async () => {
    const store = window.__hs!.store;
    const file = (document.getElementById('hsp-pick') as HTMLInputElement).files![0];
    // Start a recompose at 2048 (longer), let its debounce fire, then open before it settles.
    store.getState().setPreviewRes(2048);
    await new Promise((res) => setTimeout(res, 170));
    // Keep compositions of the old document starting while the open builds on the side.
    let i = 0;
    const timer = setInterval(() => {
      store.getState().updateNode<'wear'>('wear', { intensity: 0.3 + (++i % 5) * 0.01 });
    }, 170);
    try {
      await store.getState().openProject(file);
    } finally {
      clearInterval(timer);
    }
    const s = store.getState();
    return { error: s.projectError, dirty: s.dirty };
  });
  expect(r).toEqual({ error: null, dirty: false });
  await settled(page);
  expect(await page.evaluate(() => window.__hs!.store.getState().atlas!.resolutionPx)).toBe(2048);
  await page.evaluate(() => window.__hs!.store.getState().setPreviewRes(1024));
  await settled(page);
  const opened = await snapshot(page);
  expect(opened).toEqual(saved);
  // Let any late GPU validation message reach the console.
  await page.evaluate(() => window.__hs!.store.getState().gpu!.device.queue.onSubmittedWorkDone());
  expect(gpuErrors).toEqual([]);
});

test('dirty: false after open and save, true after one edit; beforeunload asks only while dirty', async ({ page }, testInfo) => {
  const dir = testInfo.outputPath();
  mkdirSync(dir, { recursive: true });
  await page.goto('/');
  await page.waitForFunction(() => !!window.__hs);
  expect(await dirty(page)).toBe(false);
  expect(await asksBeforeUnload(page)).toBe(false);
  await expect(page).toHaveTitle('Hotspotter');

  await page.getByTestId('folder-input').setInputFiles(BRICKS);
  await expect(page.getByTestId('structure-type')).toHaveText('Piezas');
  await settled(page);
  expect(await dirty(page)).toBe(true);
  expect(await asksBeforeUnload(page)).toBe(true);
  await expect(page).toHaveTitle('Sin título • — Hotspotter');

  const path = await saveAs(page, dir, 'limpio');
  expect(await dirty(page)).toBe(false);
  expect(await asksBeforeUnload(page)).toBe(false);

  await setField(page, 'Intensidad', '0.7');
  expect(await dirty(page)).toBe(true);
  expect(await asksBeforeUnload(page)).toBe(true);
  await expect(page.getByTestId('project-name')).toHaveText('limpio •');

  // Ctrl+S saves to the same file, even while typing in a field.
  await page.getByLabel('Intensidad', { exact: true }).focus();
  await page.keyboard.press('Control+s');
  await expect.poll(() => dirty(page)).toBe(false);
  expect(readdirSync(dir).filter((f) => f.endsWith('.hsp'))).toEqual(['limpio.hsp']);
  await page.getByLabel('Intensidad', { exact: true }).blur();

  await page.getByTestId('project-open-input').setInputFiles(path);
  await expect(page.getByTestId('unsaved-dialog')).toHaveCount(0);
  await settled(page);
  expect(await dirty(page)).toBe(false);
  expect(await asksBeforeUnload(page)).toBe(false);
  const intensity = await page.evaluate(() =>
    (window.__hs!.store.getState().doc!.nodes.find((n) => n.id === 'wear')!.params as { intensity: number }).intensity);
  expect(intensity).toBe(0.7);
});

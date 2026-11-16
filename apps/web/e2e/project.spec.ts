import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { selectLayer } from './helpers';

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
  await selectLayer(page, 'structure');
  await expect(page.getByTestId('structure-type')).toHaveText('Piezas');
  await selectLayer(page, 'wear');
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
    // Every atlas committed from now on must come from the opened document: a stale composition is discarded.
    const s = store.getState();
    const w = window as unknown as { __atlasDocs: unknown[]; __openedDoc: unknown };
    w.__openedDoc = s.doc;
    w.__atlasDocs = [];
    store.subscribe((n, p) => {
      if (n.atlas && n.atlas !== p.atlas) w.__atlasDocs.push(n.atlas.doc);
    });
    return { error: s.projectError, dirty: s.dirty };
  });
  expect(r).toEqual({ error: null, dirty: false });
  await settled(page);
  expect(await page.evaluate(() => {
    const w = window as unknown as { __atlasDocs: unknown[]; __openedDoc: unknown };
    return { some: w.__atlasDocs.length > 0, stale: w.__atlasDocs.filter((d) => d !== w.__openedDoc).length };
  })).toEqual({ some: true, stale: 0 });
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
  await selectLayer(page, 'structure');
  await expect(page.getByTestId('structure-type')).toHaveText('Piezas');
  await selectLayer(page, 'wear');
  await settled(page);
  expect(await dirty(page)).toBe(true);
  expect(await asksBeforeUnload(page)).toBe(true);
  await expect(page).toHaveTitle('Sin título • — Hotspotter');

  const path = await saveAs(page, dir, 'limpio');
  expect(await dirty(page)).toBe(false);
  expect(await asksBeforeUnload(page)).toBe(false);

  // The selected layer is view state: selecting one never makes the project dirty.
  await selectLayer(page, 'dirt');
  expect(await dirty(page)).toBe(false);
  await selectLayer(page, 'wear');
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
  await selectLayer(page, 'output');

  await page.getByTestId('project-open-input').setInputFiles(path);
  await expect(page.getByTestId('unsaved-dialog')).toHaveCount(0);
  await settled(page);
  expect(await dirty(page)).toBe(false);
  // An open shows the wear section again, as an import does.
  await expect(page.locator('[data-testid="stack-row"][data-layer="wear"]')).toHaveAttribute('aria-selected', 'true');
  expect(await asksBeforeUnload(page)).toBe(false);
  const intensity = await page.evaluate(() =>
    (window.__hs!.store.getState().doc!.nodes.find((n) => n.id === 'wear')!.params as { intensity: number }).intensity);
  expect(intensity).toBe(0.7);
});

/** Imports bricks wall 13 alone (untitled, dirty) and waits for the settled atlas. */
async function importBricks(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('folder-input').setInputFiles(BRICKS);
  await selectLayer(page, 'structure');
  await expect(page.getByTestId('structure-type')).toHaveText('Piezas');
  await selectLayer(page, 'wear');
  await settled(page);
}

/**
 * Packs a project in the page from the current material files and opens it through the store, counting the textures
 * the open created and did not destroy. `variant` picks a junk mask, a junk second set or a v0.1-A document.
 */
const openBuilt = (page: Page, variant: 'junkMask' | 'junkSubstrate' | 'oldDoc') =>
  page.evaluate(async (variant) => {
    const hs = window.__hs!;
    const s = hs.store.getState();
    const settings = s.material!.settings;
    const files = await Promise.all(
      s.sources.map(async (f) => ({ path: `material/${f.name}`, bytes: new Uint8Array(await f.arrayBuffer()) })),
    );
    const junk = new TextEncoder().encode('no es una imagen');
    const oldDoc = {
      version: 1,
      nodes: [
        { id: 'material', type: 'material', params: settings },
        { id: 'layout', type: 'layout', params: { mode: 'preset', preset: 'walls' } },
        { id: 'placement', type: 'placement', params: { variation: 0.5, seed: 0 } },
        {
          id: 'output', type: 'output',
          params: { resolutionPx: 4096, worldWidthM: 8, groove: { widthM: 0.01, bevelM: 0.005, depthM: 0.002, profile: 'round' } },
        },
      ],
      edges: [
        { from: 'material', to: 'layout', port: 'period' },
        { from: 'layout', to: 'placement', port: 'layout' },
        { from: 'placement', to: 'output', port: 'placement' },
      ],
    };
    const manifest: Record<string, unknown> = {
      app: 'test',
      doc: variant === 'oldDoc' ? oldDoc : s.doc,
      material: { name: settings.name, settings, files: files.map((f) => f.path) },
      mask: variant === 'junkMask' ? { name: 'junk.png', file: 'mask/junk.png' } : null,
      substrate: variant === 'junkSubstrate'
        ? { name: 'junk', tileSizeM: [1, 1], files: ['substrate/junk_basecolor.png'] }
        : null,
    };
    // An older build wrote no mask or substrate keys at all.
    if (variant === 'oldDoc') {
      delete manifest.mask;
      delete manifest.substrate;
    }
    const resources = [
      ...files,
      ...(variant === 'junkMask' ? [{ path: 'mask/junk.png', bytes: junk }] : []),
      ...(variant === 'junkSubstrate' ? [{ path: 'substrate/junk_basecolor.png', bytes: junk }] : []),
    ];
    const bytes = await hs.core.packProject({ manifest: manifest as never, resources });
    const device = s.gpu!.device;
    const create = device.createTexture.bind(device);
    const live = new Set<GPUTexture>();
    let created = 0;
    device.createTexture = (d: GPUTextureDescriptor) => {
      const t = create(d);
      created++;
      live.add(t);
      const destroy = t.destroy.bind(t);
      t.destroy = () => {
        live.delete(t);
        destroy();
      };
      return t;
    };
    try {
      await hs.store.getState().openProject(new File([bytes], `${variant}.hsp`));
    } finally {
      device.createTexture = create;
    }
    const n = hs.store.getState();
    return { created, leaked: live.size, error: n.projectError, nodes: n.doc?.nodes.length ?? 0 };
  }, variant);

test('a .hsp failing after the GPU uploads (junk mask or second set) keeps the project and leaks no texture', async ({ page }) => {
  await importBricks(page);
  // No evaluation in flight creates textures of its own meanwhile.
  await page.waitForFunction(() => !window.__hs!.store.getState().checksPending);
  await page.evaluate(() => {
    const s = window.__hs!.store.getState();
    (window as unknown as { __keep?: object[] }).__keep = [s.doc!, s.gpuMaterial!, s.structure!, s.material!];
  });
  const kept = () => page.evaluate(() => {
    const s = window.__hs!.store.getState();
    return (window as unknown as { __keep: object[] }).__keep
      .every((o, i) => o === [s.doc, s.gpuMaterial, s.structure, s.material][i]);
  });
  for (const variant of ['junkMask', 'junkSubstrate'] as const) {
    const r = await openBuilt(page, variant);
    // The material was uploaded before the failure, and all of it was freed.
    expect(r.created).toBeGreaterThan(0);
    expect(r.leaked).toBe(0);
    expect(r.error).toContain('No se pudo leer la imagen');
    expect(await kept()).toBe(true);
    await expect(page.getByTestId('project-error')).toBeVisible();
  }
  // The dismiss button clears the message.
  await page.getByTestId('project-error-dismiss').click();
  await expect(page.getByTestId('project-error')).toHaveCount(0);
});

test('an older .hsp (v0.1-A document, no mask or second set entries) opens migrated through the store', async ({ page }) => {
  await importBricks(page);
  const r = await openBuilt(page, 'oldDoc');
  expect(r.error).toBeNull();
  expect(r.nodes).toBe(7);
  await settled(page);
  expect(await page.evaluate(() => {
    const s = window.__hs!.store.getState();
    const st = s.doc!.nodes.find((n) => n.type === 'structure')!.params as { analyzed: boolean };
    return { mask: s.mask, substrate: s.substrate, dirty: s.dirty, analyzed: st.analyzed };
  })).toEqual({ mask: null, substrate: null, dirty: false, analyzed: true });
  await expect(page.getByTestId('project-name')).toHaveText('oldDoc');
});

test('Guardar in the unsaved-changes dialog goes through Guardar como, then runs the deferred Nuevo or Abrir', async ({ page }, testInfo) => {
  const dir = testInfo.outputPath();
  mkdirSync(dir, { recursive: true });
  await importBricks(page);

  // Nuevo → Guardar → Guardar como → saved, then the project empties.
  await page.getByTestId('file-menu').click();
  await page.getByTestId('file-new').click();
  await page.getByTestId('unsaved-save').click();
  await expect(page.getByTestId('save-as-dialog')).toBeVisible();
  await page.getByTestId('save-as-dir').fill(dir);
  await page.getByTestId('save-as-name').fill('antes');
  await page.getByTestId('save-as-run').click();
  await expect(page.getByTestId('project-name')).toHaveText('Sin proyecto');
  expect(existsSync(join(dir, 'antes.hsp'))).toBe(true);

  // Dirty again, then Abrir → Guardar → Guardar como → saved, then the picked file opens.
  await importBricks(page);
  await page.getByTestId('project-open-input').setInputFiles(join(dir, 'antes.hsp'));
  await page.getByTestId('unsaved-save').click();
  await expect(page.getByTestId('save-as-dir')).toHaveValue(dir);
  await page.getByTestId('save-as-name').fill('otro');
  await page.getByTestId('save-as-run').click();
  await expect(page.getByTestId('project-name')).toHaveText('antes');
  expect(existsSync(join(dir, 'otro.hsp'))).toBe(true);
  await settled(page);
  expect(await dirty(page)).toBe(false);

  // Re-saving an opened project: the browser hides its folder, so Guardar asks, prefilled (decision 74).
  await setField(page, 'Intensidad', '0.6');
  await page.getByTestId('file-menu').click();
  await page.getByTestId('file-save').click();
  await expect(page.getByTestId('save-as-dialog')).toBeVisible();
  await expect(page.getByTestId('save-as-name')).toHaveValue('antes');
  await expect(page.getByTestId('save-as-dir')).toHaveValue(dir);
  // Ctrl+S inside Guardar como is its Guardar button, not a reset of the dialog.
  await page.getByTestId('save-as-name').fill('tercero');
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-as-dialog')).toHaveCount(0);
  await expect(page.getByTestId('project-name')).toHaveText('tercero');
  expect(existsSync(join(dir, 'tercero.hsp'))).toBe(true);
});

test('shortcuts: Ctrl+O picks a file, Ctrl+Shift+S opens Guardar como, Ctrl+S saves uncommitted typed text', async ({ page }, testInfo) => {
  const dir = testInfo.outputPath();
  mkdirSync(dir, { recursive: true });
  await importBricks(page);
  await page.getByTestId('project-name').click();

  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Control+o');
  expect((await chooser).isMultiple()).toBe(false);

  await page.keyboard.press('Control+Shift+S');
  await expect(page.getByTestId('save-as-dialog')).toBeVisible();
  await page.getByTestId('save-as-dir').fill(dir);
  await page.getByTestId('save-as-name').fill('atajos');
  await page.getByTestId('save-as-run').click();
  await expect(page.getByTestId('save-as-dialog')).toHaveCount(0);

  // Typed but not committed (no blur): Ctrl+S commits the field first, and the file holds the new value.
  const field = page.getByLabel('Intensidad', { exact: true });
  await field.fill('0.55');
  await page.keyboard.press('Control+s');
  await expect.poll(() => dirty(page)).toBe(false);
  await settled(page);
  await page.getByTestId('project-open-input').setInputFiles(join(dir, 'atajos.hsp'));
  await expect(page.getByTestId('project-name')).toHaveText('atajos');
  await settled(page);
  expect(await page.evaluate(() =>
    (window.__hs!.store.getState().doc!.nodes.find((n) => n.id === 'wear')!.params as { intensity: number }).intensity,
  )).toBe(0.55);
});

test('a save that finishes after an open leaves the opened project its own path', async ({ page }, testInfo) => {
  const dir = testInfo.outputPath();
  mkdirSync(dir, { recursive: true });
  await importBricks(page);
  const other = await saveAs(page, dir, 'abierto');
  await page.evaluate(() => {
    const input = Object.assign(document.createElement('input'), { type: 'file', id: 'hsp-pick' });
    document.body.appendChild(input);
  });
  await page.setInputFiles('#hsp-pick', other);
  const r = await page.evaluate(async (dir) => {
    const store = window.__hs!.store;
    const file = (document.getElementById('hsp-pick') as HTMLInputElement).files![0];
    // Hold the save's write until the open has swapped its project in.
    const fetch0 = window.fetch;
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    window.fetch = async (...a: Parameters<typeof fetch>) => {
      await gate;
      return fetch0(...a);
    };
    try {
      const save = store.getState().saveProject({ dir, name: 'lento' });
      await store.getState().openProject(file);
      release();
      const written = await save;
      const s = store.getState();
      return { written: written.endsWith('lento.hsp'), path: s.projectPath, dirty: s.dirty };
    } finally {
      window.fetch = fetch0;
    }
  }, dir);
  expect(r).toEqual({ written: true, path: { dir: '', name: 'abierto.hsp' }, dirty: false });
  await expect(page.getByTestId('project-name')).toHaveText('abierto');
});

test('after opening a project the atlas is fitted, a maximized 3D stays, and the first check click still focuses', async ({ page }, testInfo) => {
  const dir = testInfo.outputPath();
  mkdirSync(dir, { recursive: true });
  await page.goto('/');
  await page.getByTestId('folder-input').setInputFiles(BRICKS);
  await expect(page.getByTestId('material-name')).toHaveValue('bricks_wall_13');
  await selectLayer(page, 'structure');
  await expect(page.getByTestId('structure-type')).toHaveText('Piezas');
  await settled(page);
  const zoom = () => page.getByTestId('atlas-stage').evaluate((el) =>
    Number(/scale\(([\d.e+-]+)\)/.exec((el as HTMLElement).style.transform)![1]));
  const warnRow = async () => {
    await page.evaluate(() => {
      const st = window.__hs!.store.getState();
      const p = st.material!.settings.period;
      return st.updateSettings({ period: { ...p, x: 0.37, cutAllowedX: false }, periodUserSet: true });
    });
    const r = page.locator('[data-testid="check-row"][data-check-id="proportions"]');
    await expect(r).toHaveAttribute('data-status', 'warn', { timeout: 20_000 });
    await expect(page.getByTestId('checks')).not.toHaveAttribute('data-pending', 'true', { timeout: 20_000 });
    return r;
  };
  await (await warnRow()).click();
  await expect.poll(zoom).toBeGreaterThanOrEqual(4);
  const path = await saveAs(page, join(dir, 'out'), 'foco');
  await page.getByRole('button', { name: 'Maximizar vista 3D' }).click();
  await page.getByTestId('project-open-input').setInputFiles(path);
  await expect(page.getByTestId('project-name')).toHaveText('foco');
  await settled(page);
  // An open keeps a maximized 3D pane.
  await expect(page.getByTestId('viewport-2d')).toBeHidden();
  await page.getByRole('button', { name: 'Restaurar vistas' }).click();
  // The opened project is fitted, not left at the old zoom.
  await expect.poll(zoom).toBeLessThan(1.01);
  // The first click after the open focuses again (the request number never goes back).
  await (await warnRow()).click();
  await expect.poll(zoom).toBeGreaterThanOrEqual(4);
});

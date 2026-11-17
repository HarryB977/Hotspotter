import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectLayer } from './helpers';

const BRICKS = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../samples/pbr/bricks wall 13');

test.skip(!existsSync(BRICKS), 'samples/pbr/bricks wall 13 not present');

test.describe('status bar with the update notice', () => {
  for (const height of [700, 450]) {
    test(`stays on one row on screen at 1366x${height}`, async ({ page }) => {
      await page.setViewportSize({ width: 1366, height });
      await page.route('**/api/update', (r) => r.fulfill({
        json: { status: 'available', version: '9.9.9', notes: 'x', url: 'https://example.com/r' },
      }));
      await page.goto('/');
      await expect(page.getByTestId('update-notice')).toBeVisible();
      const footer = page.locator('footer');
      const box = (await footer.boundingBox())!;
      expect(box.height).toBeLessThanOrEqual(30);
      expect(box.y + box.height).toBeLessThanOrEqual(height);
      expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
    });
  }
});

test.describe('app shell at a laptop-sized window', () => {
  test.use({ viewport: { width: 1366, height: 700 } });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('folder-input').setInputFiles(BRICKS);
    await expect(page.getByTestId('material-name')).toHaveValue('bricks_wall_13');
    await selectLayer(page, 'structure');
    await expect(page.getByTestId('structure-type')).toHaveText('Piezas');
    await selectLayer(page, 'wear');
  });

  test('the map bar stays on screen and only the side panels scroll', async ({ page }) => {
    const footer = page.getByRole('tablist').first();
    const box = await footer.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(700);
    // The page itself never scrolls; the side columns scroll inside themselves.
    const pageFits = () => page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight);
    expect(await pageFits()).toBe(true);
    const overflow = (id: string) => page.getByTestId(id).evaluate((el) => ({
      y: getComputedStyle(el).overflowY, sh: el.scrollHeight, ch: el.clientHeight,
    }));
    // The left column keeps a scroll as a fallback; at 700 px only the Material area, taller than its share, scrolls.
    expect((await overflow('left-column')).y).toBe('auto');
    const material = await overflow('material-scroll');
    expect(material.y).toBe('auto');
    expect(material.sh).toBeGreaterThan(material.ch);
    // The inspector shows one layer; Desgaste, selected after an import, fits at 700 px. Lower, it scrolls inside its
    // column and the page still does not.
    await expect(page.getByTestId('wear-section')).toBeVisible();
    expect((await overflow('inspector-scroll')).y).toBe('auto');
    await page.setViewportSize({ width: 1366, height: 450 });
    await expect.poll(async () => {
      const r = await overflow('inspector-scroll');
      return r.sh > r.ch;
    }).toBe(true);
    expect(await pageFits()).toBe(true);
    const bar = await footer.boundingBox();
    const innerH = await page.evaluate(() => window.innerHeight);
    expect(bar!.y + bar!.height).toBeLessThanOrEqual(innerH);
  });

  test('the whole Pila is on screen without scrolling the left column', async ({ page }) => {
    // Undo any scroll the layer clicks of beforeEach caused.
    await page.evaluate(() => {
      for (const id of ['left-column', 'material-scroll']) {
        const el = document.querySelector(`[data-testid="${id}"]`);
        if (el) el.scrollTop = 0;
      }
    });
    const left = (await page.getByTestId('left-column').boundingBox())!;
    const rows = page.getByTestId('stack-row');
    await expect(rows).toHaveCount(7);
    for (const row of [rows.first(), rows.last()]) {
      const b = (await row.boundingBox())!;
      expect(b.y).toBeGreaterThanOrEqual(Math.max(0, left.y));
      expect(b.y + b.height).toBeLessThanOrEqual(Math.min(700, left.y + left.height));
    }
  });

  test('labels are not selectable, fields are', async ({ page }) => {
    const label = await page.evaluate(() => getComputedStyle(document.body).userSelect);
    expect(label).toBe('none');
    const field = await page.getByLabel('Semilla').first().evaluate((el) => getComputedStyle(el).userSelect);
    expect(field).not.toBe('none');
  });

  test('dragging a number field left or right scrubs its value; a click still types', async ({ page }) => {
    const seed = page.getByLabel('Semilla').first();
    await seed.scrollIntoViewIfNeeded();
    await expect(seed).toHaveCSS('cursor', 'ew-resize');
    const before = Number(await seed.inputValue());
    const b = (await seed.boundingBox())!;
    const y = b.y + b.height / 2;
    await page.mouse.move(b.x + b.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + 25, y, { steps: 5 });
    await page.mouse.up();
    await expect(seed).toHaveValue(String(before + 25));
    await expect(seed).not.toBeFocused();
    // Dragging left past zero clamps at the field's minimum.
    await page.mouse.move(b.x + b.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 - 400, y, { steps: 8 });
    await page.mouse.up();
    await expect(seed).toHaveValue('0');
    // A plain click focuses the field with its text selected, ready to type.
    await seed.click();
    await expect(seed).toBeFocused();
    await page.keyboard.type('7');
    await page.keyboard.press('Enter');
    await expect(seed).toHaveValue('7');
  });
  test('the 2D | 3D divider resizes the panes, maximizes one and remembers both', async ({ page }) => {
    const atlasW = async () => (await page.getByTestId('viewport-2d').boundingBox())!.width;
    const sep = page.getByRole('separator', { name: 'Cambiar el ancho de las vistas' });
    await expect(sep).toHaveAttribute('aria-valuenow', '50');
    const w0 = await atlasW();
    const b = (await sep.boundingBox())!;
    const y = b.y + b.height / 2;
    await page.mouse.move(b.x + b.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 - 200, y, { steps: 8 });
    await page.mouse.up();
    expect(Math.abs(w0 - 200 - (await atlasW()))).toBeLessThan(6);
    // Dragging does not select text.
    expect(await page.evaluate(() => String(window.getSelection()))).toBe('');
    await page.reload();
    await expect(page.getByRole('separator', { name: 'Cambiar el ancho de las vistas' })).not.toHaveAttribute('aria-valuenow', '50');
    // Double click resets to 50 %.
    await page.getByRole('separator', { name: 'Cambiar el ancho de las vistas' }).dblclick();
    await expect(page.getByRole('separator', { name: 'Cambiar el ancho de las vistas' })).toHaveAttribute('aria-valuenow', '50');
    // Maximize 3D hides the atlas pane, and survives a reload.
    await page.getByRole('button', { name: 'Maximizar vista 3D' }).click();
    await expect(page.getByTestId('viewport-2d')).toBeHidden();
    await page.reload();
    await expect(page.getByTestId('viewport-3d')).toBeVisible();
    await expect(page.getByTestId('viewport-2d')).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
    await page.getByRole('button', { name: 'Restaurar vistas' }).click();
    await expect(page.getByTestId('viewport-2d')).toBeVisible();
    // The map bar still spans the whole centre, below both panes.
    const bar = (await page.getByRole('tablist').first().boundingBox())!;
    const atlas = (await page.getByTestId('viewport-2d').boundingBox())!;
    expect(bar.y).toBeGreaterThanOrEqual(atlas.y + atlas.height);
  });

  test('a corrupt hs.viewport value falls back to 50 %', async ({ page }) => {
    await page.evaluate(() => localStorage.setItem('hs.viewport', '{"ratio":"x","max":"zzz"}'));
    await page.reload();
    await expect(page.getByRole('separator', { name: 'Cambiar el ancho de las vistas' })).toHaveAttribute('aria-valuenow', '50');
    await expect(page.getByTestId('viewport-3d')).toBeVisible();
  });
  /** Zoom and the atlas point under the host centre, read from the stage transform. */
  const readView = (page: import('@playwright/test').Page) => page.evaluate(() => {
    const st = document.querySelector('[data-testid="atlas-stage"]') as HTMLElement;
    const host = document.querySelector('[data-testid="atlas-view"]')!.getBoundingClientRect();
    const r = st.getBoundingClientRect();
    const k = Number(/scale\(([\d.e+-]+)\)/.exec(st.style.transform)![1]);
    return { k, u: (host.left + host.width / 2 - r.left) / r.width, v: (host.top + host.height / 2 - r.top) / r.height };
  });

  test('zoom and pan survive a divider drag and a maximize/restore', async ({ page }) => {
    const host = (await page.getByTestId('atlas-view').boundingBox())!;
    await page.mouse.move(host.x + host.width * 0.3, host.y + host.height * 0.4);
    await page.mouse.wheel(0, -900);
    await expect.poll(async () => (await readView(page)).k).toBeGreaterThan(2);
    const before = await readView(page);
    const sep = page.getByRole('separator', { name: 'Cambiar el ancho de las vistas' });
    const b = (await sep.boundingBox())!;
    const y = b.y + b.height / 2;
    await page.mouse.move(b.x + b.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 - 150, y, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => Math.abs((await page.getByTestId('atlas-view').boundingBox())!.width - (host.width - 150))).toBeLessThan(6);
    const after = await readView(page);
    expect(after.k).toBeCloseTo(before.k, 5);
    expect(after.u).toBeCloseTo(before.u, 2);
    expect(after.v).toBeCloseTo(before.v, 2);
    await page.getByRole('button', { name: 'Maximizar vista 3D' }).click();
    await page.getByRole('button', { name: 'Restaurar vistas' }).click();
    await expect(page.getByTestId('viewport-2d')).toBeVisible();
    await expect.poll(async () => {
      const r = await readView(page);
      return Math.abs(r.k - before.k) + Math.abs(r.u - before.u) + Math.abs(r.v - before.v);
    }).toBeLessThan(0.01);
  });

  test('grabbing the divider off-centre does not make it jump, and a click changes nothing', async ({ page }) => {
    const sep = page.getByRole('separator', { name: 'Cambiar el ancho de las vistas' });
    const w0 = (await page.getByTestId('viewport-2d').boundingBox())!.width;
    const b = (await sep.boundingBox())!;
    const y = b.y + b.height / 2;
    await page.mouse.move(b.x - 3, y);
    await page.mouse.down();
    await page.mouse.up();
    expect(await page.evaluate(() => localStorage.getItem('hs.viewport'))).toBeNull();
    await expect(sep).toHaveAttribute('aria-valuenow', '50');
    expect(Math.abs((await page.getByTestId('viewport-2d').boundingBox())!.width - w0)).toBeLessThan(0.5);
    await page.mouse.move(b.x - 3, y);
    await page.mouse.down();
    await page.mouse.move(b.x - 3 - 100, y, { steps: 5 });
    await page.mouse.up();
    expect(Math.abs((await page.getByTestId('viewport-2d').boundingBox())!.width - (w0 - 100))).toBeLessThan(1);
  });
  test('a new material is fitted again, but a parameter change keeps the zoom', async ({ page }) => {
    const zoom = async () => (await readView(page)).k;
    const host = (await page.getByTestId('atlas-view').boundingBox())!;
    await page.mouse.move(host.x + host.width / 2, host.y + host.height / 2);
    await page.mouse.wheel(0, -900);
    await expect.poll(zoom).toBeGreaterThan(2);
    const k = await zoom();
    const f = page.getByLabel('Intensidad', { exact: true });
    await page.evaluate(() => { (window as unknown as { __atlas0: unknown }).__atlas0 = window.__hs!.store.getState().atlas; });
    await f.fill('0.7');
    await f.blur();
    // The parameter change recomposes the atlas: wait for its new identity, then check the zoom.
    await expect.poll(() => page.evaluate(() =>
      window.__hs!.store.getState().atlas !== (window as unknown as { __atlas0: unknown }).__atlas0)).toBe(true);
    expect(await zoom()).toBeCloseTo(k, 5);
    await page.getByTestId('folder-input').setInputFiles(BRICKS);
    await page.getByTestId('import-replace').click();
    await expect.poll(zoom, { timeout: 30_000 }).toBeLessThan(1.01);
  });
});

import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectLayer } from './helpers';

const BRICKS = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../samples/pbr/bricks wall 13');

test.skip(!existsSync(BRICKS), 'samples/pbr/bricks wall 13 not present');

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
});

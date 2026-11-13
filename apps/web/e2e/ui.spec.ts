import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRICKS = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../samples/pbr/bricks wall 13');

test.skip(!existsSync(BRICKS), 'samples/pbr/bricks wall 13 not present');

test.describe('app shell at a laptop-sized window', () => {
  test.use({ viewport: { width: 1366, height: 700 } });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('folder-input').setInputFiles(BRICKS);
    await expect(page.getByTestId('material-name')).toHaveValue('bricks_wall_13');
    await expect(page.getByTestId('structure-type')).toHaveText('Piezas');
  });

  test('the map bar stays on screen and only the side panels scroll', async ({ page }) => {
    const footer = page.getByRole('tablist').first();
    const box = await footer.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(700);
    // The page itself never scrolls; the long inspector scrolls inside its own column.
    const page_ = await page.evaluate(() => ({
      docH: document.documentElement.scrollHeight,
      winH: window.innerHeight,
    }));
    expect(page_.docH).toBeLessThanOrEqual(page_.winH);
    const inspector = page.getByText(/Desgaste/).first().locator('xpath=ancestor::div[contains(@class,"overflow-y-auto")][1]');
    const scroll = await inspector.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
    expect(scroll.sh).toBeGreaterThan(scroll.ch);
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
});

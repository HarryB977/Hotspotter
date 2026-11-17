import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

const AVAILABLE = { status: 'available', version: '1.2.3', notes: 'Corrige **bugs**', url: 'https://example.com/releases/v1.2.3' };

async function mockUpdate(page: Page, body: unknown, status = 200) {
  await page.route('**/api/update', (r) => r.fulfill({ status, json: body }));
}

test('an available update shows the version and the four controls', async ({ page }) => {
  await mockUpdate(page, AVAILABLE);
  await page.goto('/');
  const notice = page.getByTestId('update-notice');
  await expect(notice).toContainText('Hotspotter 1.2.3 disponible');
  for (const name of ['Notas', 'Descargar', 'Más tarde', 'Omitir esta versión']) {
    await expect(notice.getByRole('button', { name })).toBeVisible();
  }
});

test('Descargar opens the release url in a new tab', async ({ page }) => {
  await mockUpdate(page, AVAILABLE);
  await page.route('https://example.com/**', (r) => r.fulfill({ body: 'ok', contentType: 'text/html' }));
  await page.goto('/');
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Descargar' }).click();
  const popup = await popupPromise;
  await popup.waitForURL(AVAILABLE.url);
  // noopener: the new tab has no handle back to the app.
  expect(await popup.evaluate(() => window.opener)).toBeNull();
});

test('Omitir esta versión posts the skip with the header and hides the notice', async ({ page }) => {
  await mockUpdate(page, AVAILABLE);
  let req: { headers: Record<string, string>; body: string | null } | null = null;
  await page.route('**/api/update/skip', (r) => {
    req = { headers: r.request().headers(), body: r.request().postData() };
    return r.fulfill({ status: 204 });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Omitir esta versión' }).click();
  await expect(page.getByTestId('update-notice')).toHaveCount(0);
  await expect.poll(() => req).not.toBeNull();
  expect(req!.headers['x-hotspotter']).toBe('1');
  expect(JSON.parse(req!.body!)).toEqual({ version: '1.2.3' });
});

test('Más tarde hides the notice until the next load', async ({ page }) => {
  await mockUpdate(page, AVAILABLE);
  await page.goto('/');
  await page.getByRole('button', { name: 'Más tarde' }).click();
  await expect(page.getByTestId('update-notice')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('update-notice')).toBeVisible();
});

test('authError shows one muted Spanish line that can be dismissed', async ({ page }) => {
  await mockUpdate(page, { status: 'authError' });
  await page.goto('/');
  const line = page.getByTestId('update-auth-error');
  await expect(line).toContainText('No se pueden comprobar actualizaciones; pide la versión nueva');
  await line.getByRole('button', { name: 'Cerrar aviso' }).click();
  await expect(line).toHaveCount(0);
});

test('a 404 (dev server) shows nothing', async ({ page }) => {
  await mockUpdate(page, { error: 'not found' }, 404);
  await page.goto('/');
  await expect(page.getByTestId('gpu-info')).toBeVisible();
  await expect(page.getByTestId('update-notice')).toHaveCount(0);
  await expect(page.getByTestId('update-auth-error')).toHaveCount(0);
});

test('release notes render as plain text, never as HTML', async ({ page }) => {
  await mockUpdate(page, { ...AVAILABLE, notes: '<script>window.__pwned = 1</script>\n<b>hola</b>' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Notas' }).click();
  const notes = page.getByTestId('update-notes');
  await expect(notes).toContainText('<script>window.__pwned = 1</script>');
  await expect(notes).toContainText('<b>hola</b>');
  expect(await notes.locator('b, script').count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
});

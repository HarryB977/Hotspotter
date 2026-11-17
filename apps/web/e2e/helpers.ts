import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { NodeType } from '@hotspotter/core';

/** Selects a layer in the Pila, so the inspector shows that layer's section. */
export async function selectLayer(page: Page, type: NodeType): Promise<void> {
  const row = page.locator(`[data-testid="stack-row"][data-layer="${type}"]`);
  // Left edge: the icon and label, never the row's switch.
  await row.click({ position: { x: 6, y: 6 } });
  await expect(row).toHaveAttribute('aria-selected', 'true');
}

/** Waits until the shown atlas was composed from the current document, material, mask and substrate. */
export const settled = (page: Page) =>
  page.waitForFunction(() => {
    const s = window.__hs?.store.getState();
    return !!s?.atlas && !!s.structure && !s.importing && s.analysisIdle && s.atlas.doc === s.doc &&
      s.atlas.gpuMaterial === s.gpuMaterial && s.atlas.mask === s.mask && s.atlas.substrate === s.substrate &&
      s.atlas.resolutionPx === s.previewRes;
  });

/** Saves through Archivo > Guardar como… and returns the written path. */
export async function saveAs(page: Page, dir: string, name: string): Promise<string> {
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

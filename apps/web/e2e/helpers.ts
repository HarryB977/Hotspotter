import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { NodeType } from '@hotspotter/core';

/** Selects a layer in the Pila, so the inspector shows that layer's section. */
export async function selectLayer(page: Page, type: NodeType): Promise<void> {
  const row = page.locator(`[data-testid="stack-row"][data-layer="${type}"]`);
  // Left edge: the icon and label, never the row's switch.
  await row.click({ position: { x: 6, y: 6 } });
  await expect(row).toHaveAttribute('aria-selected', 'true');
}

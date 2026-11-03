import type { Locator, Page } from '@playwright/test';
import { tokens } from '../src/index.ts';
import { expect } from './fixtures.ts';

// The sheet that a select, menu or popover opens in below the small breakpoint: the dialog
// holding the title, on the scrim at the end of the page.
export const sheetPanel = (page: Page, title: string): Locator =>
  page.locator('[data-sheet] [role="dialog"]').filter({
    has: page.getByRole('heading', { name: title, exact: true }),
  });

// Below the small breakpoint the panel spans the viewport and sits on its bottom edge, with
// its title shown and every row at least the comfortable row tall.
export async function expectSheet(
  page: Page,
  title: string,
  rowRole?: 'option' | 'menuitem',
): Promise<void> {
  const panel = sheetPanel(page, title);
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: title, exact: true })).toBeVisible();
  // The rise has finished before the edges are measured.
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error('no viewport');
  await expect
    .poll(async () => {
      const box = await panel.boundingBox();
      return box === null
        ? null
        : {
            left: Math.round(box.x),
            right: Math.round(box.x + box.width),
            bottom: Math.round(box.y + box.height),
          };
    })
    .toEqual({ left: 0, right: viewport.width, bottom: viewport.height });
  if (rowRole === undefined) return;
  const heights = await panel
    .getByRole(rowRole)
    .evaluateAll((rows) => rows.map((r) => r.getBoundingClientRect().height));
  expect(heights.length).toBeGreaterThan(0);
  for (const height of heights) expect(height).toBeGreaterThanOrEqual(tokens.size.row.comfortable);
}

// A press on the scrim above the panel, where nothing else sits.
export async function pressScrim(page: Page): Promise<void> {
  await page
    .locator('[data-sheet]')
    .last()
    .click({ position: { x: 8, y: 8 } });
}

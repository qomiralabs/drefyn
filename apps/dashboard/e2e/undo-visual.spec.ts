import { expect, type Page } from '@playwright/test';
import { test } from './csp.ts';
import { DESKTOP, MOBILE, THEMES, useTheme } from './fixtures.ts';
import { archive, openPages, refuseWrites, select, toastRegion } from './undo-helpers.ts';

// Same pinned image rule as visual.spec.ts.
const PINNED =
  'mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea';

const SIZES = { desktop: DESKTOP, mobile: MOBILE } as const;

const STATES: Readonly<Record<string, (page: Page) => Promise<void>>> = {
  pages: () => Promise.resolve(),
  'pages-undo-toast': async (page) => {
    await select(page, 'Refunds');
    await archive(page).click();
    await expect(toastRegion(page).getByRole('button', { name: 'Undo' })).toBeVisible();
    await page.mouse.move(0, 0);
  },
  'pages-error-toast': async (page) => {
    await refuseWrites(page);
    await select(page, 'Refunds');
    await archive(page).click();
    await expect(toastRegion(page).getByRole('alert')).toBeVisible();
    await page.mouse.move(0, 0);
  },
};

for (const [name, reach] of Object.entries(STATES)) {
  for (const theme of THEMES) {
    for (const [size, viewport] of Object.entries(SIZES)) {
      test(`${name} ${theme} ${size}`, async ({ page }) => {
        expect(process.env['DREFYN_PLAYWRIGHT_IMAGE'], 'run inside the pinned image').toBe(PINNED);
        await page.setViewportSize(viewport);
        await useTheme(page, theme);
        await openPages(page);
        await page.evaluate(() => document.fonts.ready);
        await reach(page);
        await expect(page).toHaveScreenshot(`${name}_${size}-${theme}.png`);
      });
    }
  }
}

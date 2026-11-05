import { expect } from '@playwright/test';
import { test } from './csp.ts';
import { DESKTOP, MOBILE, openShell, THEMES, useTheme } from './fixtures.ts';
import { COCKPIT, DOCS_PAGES, heading, incidentOpen, line } from './incident-helpers.ts';

// Same pinned image rule as visual.spec.ts.
const PINNED =
  'mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea';

const SIZES = { desktop: DESKTOP, mobile: MOBILE } as const;

for (const theme of THEMES) {
  for (const [size, viewport] of Object.entries(SIZES)) {
    test.describe(`${theme} ${size}`, () => {
      test.beforeEach(async ({ page }) => {
        expect(process.env['DREFYN_PLAYWRIGHT_IMAGE'], 'run inside the pinned image').toBe(PINNED);
        await page.setViewportSize(viewport);
        await useTheme(page, theme);
        await incidentOpen(page);
      });

      test('incident mode', async ({ page }) => {
        await openShell(page, COCKPIT);
        await expect(heading(page)).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        await expect(page).toHaveScreenshot(`incident-mode_${size}-${theme}.png`);
      });

      test('the incident line on a docs page', async ({ page }) => {
        await openShell(page, DOCS_PAGES);
        await expect(line(page)).toBeVisible();
        await expect(page.getByRole('grid', { name: 'Pages' })).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        await expect(page).toHaveScreenshot(`incident-line_${size}-${theme}.png`);
      });
    });
  }
}

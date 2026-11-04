import { expect } from '@playwright/test';
import { authStatePaths, SELF_HOSTED } from './auth-states.ts';
import { test } from './csp.ts';
import { DESKTOP, MOBILE, openShell, ROUTES, THEMES, useTheme } from './fixtures.ts';
import { SIGNED_OUT } from './people.ts';

// Baselines are made and compared only inside the pinned Playwright image, where fonts render
// the same on every machine. Anywhere else this fails rather than writing host pixels.
const PINNED =
  'mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea';

const SIZES = { desktop: DESKTOP, mobile: MOBILE } as const;
const SHOTS = ['overview', 'project', 'empty', 'error'] as const;

for (const name of SHOTS) {
  for (const theme of THEMES) {
    for (const [size, viewport] of Object.entries(SIZES)) {
      test(`${name} ${theme} ${size}`, async ({ page }) => {
        expect(process.env['DREFYN_PLAYWRIGHT_IMAGE'], 'run inside the pinned image').toBe(PINNED);
        await page.setViewportSize(viewport);
        await useTheme(page, theme);
        await openShell(page, ROUTES[name]);
        await page.evaluate(() => document.fonts.ready);
        await expect(page).toHaveScreenshot(`${name}_${size}-${theme}.png`, { fullPage: true });
      });
    }
  }
}

// Signed out pages and every state of them, drawn from fixed words with no account.
test.describe('signed out pages', () => {
  test.use({ storageState: SIGNED_OUT });

  for (const [name, path] of [...authStatePaths(), ['sign-in-self-hosted', SELF_HOSTED]] as const) {
    for (const theme of THEMES) {
      for (const [size, viewport] of Object.entries(SIZES)) {
        test(`${name} ${theme} ${size}`, async ({ page }) => {
          expect(process.env['DREFYN_PLAYWRIGHT_IMAGE'], 'run inside the pinned image').toBe(
            PINNED,
          );
          await page.setViewportSize(viewport);
          await useTheme(page, theme);
          await page.goto(path);
          await page.evaluate(() => document.fonts.ready);
          await expect(page).toHaveScreenshot(`auth-${name}_${size}-${theme}.png`, {
            fullPage: true,
          });
        });
      }
    }
  }
});

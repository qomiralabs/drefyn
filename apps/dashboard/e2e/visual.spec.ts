import { expect } from '@playwright/test';
import { authStatePaths, SELF_HOSTED } from './auth-states.ts';
import { test } from './csp.ts';
import {
  commandBar,
  DESKTOP,
  inbox,
  MOBILE,
  openShell,
  ROUTES,
  routeCommandBar,
  settingsStatePaths,
  shortcutsSheet,
  TABLET,
  THEMES,
  useTheme,
} from './fixtures.ts';
import { ADA, SAM, SIGNED_OUT, stateFile } from './people.ts';

// Baselines are made and compared only inside the pinned Playwright image, where fonts render
// the same on every machine. Anywhere else this fails rather than writing host pixels.
const PINNED =
  'mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea';

const SIZES = { desktop: DESKTOP, mobile: MOBILE } as const;
// The project shot is the gallery's, since no product feeds a real project home yet.
const SHOTS = {
  overview: ROUTES.overview,
  project: ROUTES.success,
  empty: ROUTES.empty,
  error: ROUTES.error,
} as const;

for (const [name, path] of Object.entries(SHOTS)) {
  for (const theme of THEMES) {
    for (const [size, viewport] of Object.entries(SIZES)) {
      test(`${name} ${theme} ${size}`, async ({ page }) => {
        expect(process.env['DREFYN_PLAYWRIGHT_IMAGE'], 'run inside the pinned image').toBe(PINNED);
        await page.setViewportSize(viewport);
        await useTheme(page, theme);
        await openShell(page, path);
        await page.evaluate(() => document.fonts.ready);
        await expect(page).toHaveScreenshot(`${name}_${size}-${theme}.png`, { fullPage: true });
      });
    }
  }
}

// Every settings page in every state, from fixed words, so failures and limits are drawn too.
for (const [name, path] of settingsStatePaths()) {
  for (const theme of THEMES) {
    for (const [size, viewport] of Object.entries(SIZES)) {
      test(`settings ${name} ${theme} ${size}`, async ({ page }) => {
        expect(process.env['DREFYN_PLAYWRIGHT_IMAGE'], 'run inside the pinned image').toBe(PINNED);
        await page.setViewportSize(viewport);
        await useTheme(page, theme);
        await openShell(page, path);
        await page.evaluate(() => document.fonts.ready);
        await expect(page).toHaveScreenshot(`settings-${name}_${size}-${theme}.png`, {
          fullPage: true,
        });
      });
    }
  }
}

// The shell as each role sees it, with the command bar open on what that role may reach.
for (const [role, person] of [
  ['admin', ADA],
  ['member', SAM],
] as const) {
  test.describe(`the shell as ${role}`, () => {
    test.use({ storageState: stateFile(person) });

    for (const theme of THEMES) {
      for (const [size, viewport] of Object.entries(SIZES)) {
        test(`${role} shell ${theme} ${size}`, async ({ page }) => {
          expect(process.env['DREFYN_PLAYWRIGHT_IMAGE'], 'run inside the pinned image').toBe(
            PINNED,
          );
          await page.setViewportSize(viewport);
          await useTheme(page, theme);
          await openShell(page, ROUTES.overview);
          await page.evaluate(() => document.fonts.ready);
          await expect(page).toHaveScreenshot(`shell-${role}_${size}-${theme}.png`, {
            fullPage: true,
          });
          await page.keyboard.press('ControlOrMeta+k');
          // The results, not the frame that stands in while their code loads.
          await expect(commandBar(page).getByRole('option').first()).toBeVisible();
          await expect(page).toHaveScreenshot(`shell-${role}-command_${size}-${theme}.png`);
        });
      }
    }
  });
}

// The shell's own overlays: the inbox open over a project, the shortcuts sheet, and the
// command bar's frame while its code is still on the way.
for (const theme of THEMES) {
  for (const [size, viewport] of Object.entries(SIZES)) {
    test(`inbox ${theme} ${size}`, async ({ page }) => {
      expect(process.env['DREFYN_PLAYWRIGHT_IMAGE'], 'run inside the pinned image').toBe(PINNED);
      await page.setViewportSize(viewport);
      await useTheme(page, theme);
      await openShell(page, ROUTES.success);
      await page.evaluate(() => document.fonts.ready);
      await page.getByRole('button', { name: /^Inbox/ }).click();
      await expect(inbox(page)).toBeVisible();
      await expect(page).toHaveScreenshot(`shell-inbox_${size}-${theme}.png`);
    });

    test(`shortcuts ${theme} ${size}`, async ({ page }) => {
      expect(process.env['DREFYN_PLAYWRIGHT_IMAGE'], 'run inside the pinned image').toBe(PINNED);
      await page.setViewportSize(viewport);
      await useTheme(page, theme);
      await openShell(page, ROUTES.overview);
      await page.evaluate(() => document.fonts.ready);
      await page.keyboard.press('?');
      await expect(shortcutsSheet(page)).toBeVisible();
      await expect(page).toHaveScreenshot(`shell-shortcuts_${size}-${theme}.png`);
    });

    test(`command frame loading ${theme} ${size}`, async ({ page }) => {
      expect(process.env['DREFYN_PLAYWRIGHT_IMAGE'], 'run inside the pinned image').toBe(PINNED);
      const chunk = await routeCommandBar(page, 'hold');
      await page.setViewportSize(viewport);
      await useTheme(page, theme);
      await openShell(page, ROUTES.overview);
      await page.evaluate(() => document.fonts.ready);
      await page.keyboard.press('ControlOrMeta+k');
      await expect(commandBar(page).locator('[data-pending-rows] > span').first()).toBeVisible();
      await expect(page).toHaveScreenshot(`shell-command-loading_${size}-${theme}.png`);
      chunk.release();
    });
  }

  // The tablet rail, with the tooltip that names the focused item beside it.
  test(`rail tooltip ${theme} tablet`, async ({ page }) => {
    expect(process.env['DREFYN_PLAYWRIGHT_IMAGE'], 'run inside the pinned image').toBe(PINNED);
    await page.setViewportSize(TABLET);
    await useTheme(page, theme);
    await openShell(page, ROUTES.success);
    await page.evaluate(() => document.fonts.ready);
    await page.keyboard.press('F6');
    await page.keyboard.press('F6');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(page.locator('[role="tooltip"]')).toHaveText('Home');
    await expect(page).toHaveScreenshot(`shell-rail-tooltip_tablet-${theme}.png`);
  });
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

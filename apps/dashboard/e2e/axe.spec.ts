import { AxeBuilder } from '@axe-core/playwright';
import { expect } from '@playwright/test';
import { authStatePaths, SELF_HOSTED } from './auth-states.ts';
import {
  FACTOR_PAGES,
  inbox,
  MOBILE,
  ROUTES,
  routeCommandBar,
  settingsStatePaths,
  shortcutsSheet,
  TABLET,
  THEMES,
  useTheme,
} from './fixtures.ts';
import { SIGNED_OUT } from './people.ts';
import { test } from './test.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const WIDTHS = ['wide', '390'] as const;

for (const [state, path] of Object.entries(ROUTES)) {
  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      test(`${state} (${path}) has no axe violations in ${theme} at ${width}`, async ({ page }) => {
        if (width === '390') await page.setViewportSize(MOBILE);
        await useTheme(page, theme);
        // The loading route never finishes, so it is checked as soon as the skeleton is in.
        await page.goto(path, { waitUntil: state === 'loading' ? 'commit' : 'load' });
        await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeAttached();
        const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        expect(
          violations.map(
            (v) =>
              `${v.id} (${v.nodes.length}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
          ),
        ).toEqual([]);
      });
    }
  }
}

for (const state of FACTOR_PAGES) {
  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      test(`the factor ${state} page has no axe violations in ${theme} at ${width}`, async ({
        page,
      }) => {
        if (width === '390') await page.setViewportSize(MOBILE);
        await page.emulateMedia({ colorScheme: theme });
        await page.goto(`/settings-states/factor/${state}`);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        expect(violations.map((v) => v.id)).toEqual([]);
      });
    }
  }
}

for (const theme of THEMES) {
  test(`the open command bar has no axe violations in ${theme}`, async ({ page }) => {
    await useTheme(page, theme);
    await page.goto(ROUTES.overview);
    await expect(page.locator('html')).toHaveAttribute('data-shell', 'ready');
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByRole('dialog', { name: 'Search or run a command' })).toBeVisible();
    const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(violations.map((v) => v.id)).toEqual([]);
  });

  test(`the open drawer has no axe violations in ${theme}`, async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await useTheme(page, theme);
    await page.goto(ROUTES.project);
    await expect(page.locator('html')).toHaveAttribute('data-shell', 'ready');
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(violations.map((v) => v.id)).toEqual([]);
  });
}

// The shell's own overlays, open, in both themes on a wide screen and a phone; the rail's
// tooltip at tablet width, where the rail is.
for (const theme of THEMES) {
  for (const [width, viewport] of [
    ['wide', { width: 1280, height: 800 }],
    ['390', MOBILE],
  ] as const) {
    test(`the open inbox has no axe violations in ${theme} at ${width}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await useTheme(page, theme);
      await page.goto(ROUTES.success);
      await expect(page.locator('html')).toHaveAttribute('data-shell', 'ready');
      await page.getByRole('button', { name: /^Inbox/ }).click();
      await expect(inbox(page)).toBeVisible();
      // Measured once it has faded in, not halfway.
      await inbox(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
      const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      expect(violations.map((v) => v.id)).toEqual([]);
    });

    test(`the shortcuts sheet has no axe violations in ${theme} at ${width}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await useTheme(page, theme);
      await page.goto(ROUTES.overview);
      await expect(page.locator('html')).toHaveAttribute('data-shell', 'ready');
      await page.keyboard.press('?');
      await expect(shortcutsSheet(page)).toBeVisible();
      const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      expect(violations.map((v) => v.id)).toEqual([]);
    });

    test(`the command bar frame, still loading, has no axe violations in ${theme} at ${width}`, async ({
      page,
    }) => {
      const chunk = await routeCommandBar(page, 'hold');
      await page.setViewportSize(viewport);
      await useTheme(page, theme);
      await page.goto(ROUTES.overview);
      await expect(page.locator('html')).toHaveAttribute('data-shell', 'ready');
      await page.keyboard.press('ControlOrMeta+k');
      const bar = page.getByRole('dialog', { name: 'Search or run a command' });
      await expect(bar.locator('[data-pending-rows] > span').first()).toBeVisible();
      const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      expect(violations.map((v) => v.id)).toEqual([]);
      chunk.release();
    });
  }

  test(`the rail with its tooltip open has no axe violations in ${theme}`, async ({ page }) => {
    await page.setViewportSize(TABLET);
    await useTheme(page, theme);
    await page.goto(ROUTES.project);
    await expect(page.locator('html')).toHaveAttribute('data-shell', 'ready');
    await page.keyboard.press('F6');
    await page.keyboard.press('F6');
    await page.keyboard.press('Tab');
    await expect(page.locator('[role="tooltip"]')).toBeVisible();
    const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(violations.map((v) => v.id)).toEqual([]);
  });
}

// React Aria wraps the listbox's empty state in a role option, so nothing focusable may sit in
// it. Checked where people meet it: no results, in both themes and at every width.
for (const theme of THEMES) {
  for (const [width, viewport] of [
    ['1280', { width: 1280, height: 800 }],
    ['834', TABLET],
    ['390', MOBILE],
  ] as const) {
    test(`the command bar with no results has no axe violations in ${theme} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await useTheme(page, theme);
      await page.goto(ROUTES.overview);
      await expect(page.locator('html')).toHaveAttribute('data-shell', 'ready');
      await page.keyboard.press('ControlOrMeta+k');
      const bar = page.getByRole('dialog', { name: 'Search or run a command' });
      await expect(bar).toBeVisible();
      await page.keyboard.type('zzzz');
      await expect(bar.getByText('Nothing matches “zzzz”.')).toBeVisible();
      await expect(bar.locator('[role="listbox"] a, [role="listbox"] button')).toHaveCount(0);
      const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      expect(violations.map((v) => v.id)).toEqual([]);
    });
  }
}

// A dialog takes the page's main out of the tree, so these wait for the shell instead.
for (const [name, path] of settingsStatePaths()) {
  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      test(`settings ${name} has no axe violations in ${theme} at ${width}`, async ({ page }) => {
        if (width === '390') await page.setViewportSize(MOBILE);
        await useTheme(page, theme);
        await page.goto(path);
        await expect(page.locator('html')).toHaveAttribute('data-shell', 'ready');
        const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        expect(violations.map((v) => v.id)).toEqual([]);
      });
    }
  }
}

test.describe('signed out pages', () => {
  test.use({ storageState: SIGNED_OUT });

  for (const [name, path] of [
    ...authStatePaths(),
    ['sign-in-self-hosted', SELF_HOSTED],
    ['the real sign in page', '/sign-in'],
    ['the real sign up page', '/sign-up'],
    ['the real password page', '/sign-in/password'],
    ['the real reset page', '/sign-in/reset'],
    ['the real verify page', '/sign-in/verify'],
  ] as const) {
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        test(`${name} has no axe violations in ${theme} at ${width}`, async ({ page }) => {
          if (width === '390') await page.setViewportSize(MOBILE);
          await useTheme(page, theme);
          await page.goto(path);
          await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeAttached();
          const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
          expect(violations.map((v) => v.id)).toEqual([]);
        });
      }
    }
  }
});

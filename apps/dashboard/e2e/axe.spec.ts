import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { MOBILE, ROUTES, THEMES, useTheme } from './fixtures.ts';

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

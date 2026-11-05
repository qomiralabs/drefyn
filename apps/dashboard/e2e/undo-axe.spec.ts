import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { MOBILE, THEMES, useTheme } from './fixtures.ts';
import { test } from './test.ts';
import {
  archive,
  openPages,
  refuseWrites,
  select,
  selectAll,
  toastRegion,
} from './undo-helpers.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

async function violations(page: Page): Promise<string[]> {
  const { violations: found } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return found.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

for (const theme of THEMES) {
  for (const width of ['wide', '390'] as const) {
    test.describe(`${theme} at ${width}`, () => {
      test.beforeEach(async ({ page }) => {
        if (width === '390') await page.setViewportSize(MOBILE);
        await useTheme(page, theme);
        await openPages(page);
      });

      test('the Pages view has no axe violations', async ({ page }) => {
        expect(await violations(page)).toEqual([]);
      });

      test('the undo toast has no axe violations', async ({ page }) => {
        await select(page, 'Refunds');
        await archive(page).click();
        await expect(toastRegion(page).getByRole('button', { name: 'Undo' })).toBeVisible();
        expect(await violations(page)).toEqual([]);
      });

      test('the error toast has no axe violations', async ({ page }) => {
        await refuseWrites(page);
        await select(page, 'Refunds');
        await archive(page).click();
        await expect(toastRegion(page).getByRole('alert')).toBeVisible();
        expect(await violations(page)).toEqual([]);
      });

      test('the empty state has no axe violations', async ({ page }) => {
        await selectAll(page);
        await archive(page).click();
        await expect(page.getByRole('heading', { name: 'No pages to show' })).toBeVisible();
        expect(await violations(page)).toEqual([]);
      });
    });
  }
}

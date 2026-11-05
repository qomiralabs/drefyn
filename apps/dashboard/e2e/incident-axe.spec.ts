import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { MOBILE, openShell, THEMES, useTheme } from './fixtures.ts';
import { COCKPIT, DOCS_PAGES, heading, incidentOpen, line } from './incident-helpers.ts';
import { test } from './test.ts';

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
      });

      test('incident mode has no axe violations', async ({ page }) => {
        await incidentOpen(page);
        await openShell(page, COCKPIT);
        await expect(heading(page)).toBeVisible();
        expect(await violations(page)).toEqual([]);
      });

      test('the incident line has no axe violations', async ({ page }) => {
        await incidentOpen(page);
        await openShell(page, DOCS_PAGES);
        await expect(line(page)).toBeVisible();
        expect(await violations(page)).toEqual([]);
      });

      test('the closed incident page has no axe violations', async ({ page }) => {
        await openShell(page, COCKPIT);
        await expect(page.getByRole('heading', { name: /not open/ })).toBeVisible();
        expect(await violations(page)).toEqual([]);
      });
    });
  }
}

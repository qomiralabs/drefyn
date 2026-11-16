import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { open, PAGES, THEMES, WIDTHS, type Width } from './fixtures.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

for (const target of PAGES) {
  for (const theme of THEMES) {
    for (const width of Object.keys(WIDTHS) as Width[]) {
      test(`${target.id} has no axe violations in ${theme} at ${width}`, async ({ page }) => {
        // axe walks every node through the protocol, which WebKit answers slowly.
        test.setTimeout(60_000);
        await open(page, target, theme, width);
        const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        const found = results.violations.map((v) => ({
          rule: v.id,
          targets: v.nodes.map((n) => n.target.join(' ')),
        }));
        expect(found).toEqual([]);
      });
    }
  }
}

import { AxeBuilder } from '@axe-core/playwright';
import { expect, MOBILE, openStory, storyIds, test, THEMES } from './fixtures.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

for (const id of storyIds()) {
  for (const theme of THEMES) {
    for (const width of ['wide', '390'] as const) {
      test(`${id} has no axe violations in ${theme} at ${width}`, async ({ page }) => {
        if (width === '390') await page.setViewportSize(MOBILE);
        await openStory(page, id, theme);
        const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        expect(
          violations.map(
            (v) => `${v.id}: ${v.nodes.map((node) => node.target.join(' ')).join(', ')}`,
          ),
        ).toEqual([]);
      });
    }
  }
}

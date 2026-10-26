import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, INDEX, indexEntries, MOBILE, openPage, test, THEMES } from './fixtures.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const WIDTHS = ['wide', '390'] as const;

const targets = indexEntries();
let planned = 0;

for (const entry of targets) {
  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      planned += 1;
      test(`${entry.type} ${entry.id} has no axe violations in ${theme} at ${width}`, async ({
        page,
      }) => {
        if (width === '390') await page.setViewportSize(MOBILE);
        await openPage(page, entry, theme);
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

// Read the index on its own here, so a filter that drops a page type fails this test.
test('axe covers every story and docs page the build lists', () => {
  const { entries } = JSON.parse(readFileSync(INDEX, 'utf8')) as {
    entries: Record<string, { type: string }>;
  };
  const listed = Object.values(entries);
  const stories = listed.filter((e) => e.type === 'story').length;
  const docs = listed.filter((e) => e.type === 'docs').length;
  expect(docs, 'docs pages in the build').toBeGreaterThan(0);
  expect(stories, 'stories in the build').toBeGreaterThan(0);
  expect(targets.filter((e) => e.type === 'story')).toHaveLength(stories);
  expect(targets.filter((e) => e.type === 'docs')).toHaveLength(docs);
  expect(planned).toBe((stories + docs) * THEMES.length * WIDTHS.length);
});

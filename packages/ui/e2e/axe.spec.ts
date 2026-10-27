import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { reportedViolations, SHORTCUT_ITEM_RULE } from './axe-rules.ts';
import { expect, INDEX, indexEntries, MOBILE, openPage, ORIGIN, test, THEMES } from './fixtures.ts';

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
        const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        expect(await reportedViolations(page, results)).toEqual([]);
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

// The shortcut item exclusion must stay that narrow, so each near miss is run through the
// same filter and must still be reported.
const CASES = [
  {
    name: 'a menu item with its key and aria-keyshortcuts',
    item: '<div role="menuitem" tabindex="-1" aria-label="Open monitor" aria-keyshortcuts="O">Open monitor <kbd>O</kbd></div>',
    reported: false,
  },
  {
    name: 'the same item without aria-keyshortcuts',
    item: '<div role="menuitem" tabindex="-1" aria-label="Open monitor">Open monitor <kbd>O</kbd></div>',
    reported: true,
  },
  {
    name: 'an item with aria-keyshortcuts whose label is not in its name',
    item: '<div role="menuitem" tabindex="-1" aria-label="Open monitor" aria-keyshortcuts="O">Delete project <kbd>O</kbd></div>',
    reported: true,
  },
  {
    name: 'a button with aria-keyshortcuts and a key in its text',
    item: '<button type="button" aria-label="Open monitor" aria-keyshortcuts="O">Open monitor <kbd>O</kbd></button>',
    reported: true,
  },
];

for (const { name, item, reported } of CASES) {
  test(`${SHORTCUT_ITEM_RULE} is ${reported ? 'reported' : 'let through'} for ${name}`, async ({
    page,
  }) => {
    const html = `<!doctype html><html lang="en"><head><title>Menu</title></head><body><main><div role="menu" aria-label="Actions">${item}</div></main></body></html>`;
    await page.route(`${ORIGIN}/axe-case.html`, (route) =>
      route.fulfill({ contentType: 'text/html', body: html }),
    );
    await page.goto('/axe-case.html');
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    // The rule must actually fire on the raw page, or the filter is tested on nothing.
    expect(results.violations.map((v) => v.id)).toContain(SHORTCUT_ITEM_RULE);
    const lines = await reportedViolations(page, results);
    expect(lines.some((line) => line.startsWith(`${SHORTCUT_ITEM_RULE} `))).toBe(reported);
  });
}

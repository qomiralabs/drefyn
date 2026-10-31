import { docsEntry, docsReadiness, expect, indexEntries, openPage, test } from './fixtures.ts';

// The ready wait trusts Storybook's element ids. If an upgrade renames them, nothing would
// match and the wait would pass on height alone, so one page pins the ids against the index.
test('a docs page shows one anchor and one story root for each story the index lists', async ({
  page,
}) => {
  const entry = docsEntry('components-dialog--docs');
  const stories = indexEntries()
    .filter((e) => e.type === 'story' && e.title === entry.title)
    .map((e) => e.id)
    .sort();
  expect(stories.length).toBeGreaterThan(1);
  await openPage(page, entry, 'light');
  const ids = await page.evaluate(() => {
    const read = (selector: string) =>
      [...document.querySelectorAll(`#storybook-docs ${selector}`)].map((el) => el.id);
    return {
      anchors: read('[id^="anchor--"]').map((id) => id.replace(/^anchor--/, '')),
      roots: read('[id^="story--"][id$="-inner"]').map((id) =>
        id.replace(/^story--/, '').replace(/-inner$/, ''),
      ),
    };
  });
  // The block at the top repeats the first story as primary--<id> and <id>--primary; drop
  // exactly those, since a story may itself be called primary.
  const primary = (id: string) =>
    id.startsWith('primary--') || stories.some((s) => id === `${s}--primary`);
  const own = (list: string[]) => list.filter((id) => !primary(id));
  expect(ids.anchors.length).toBe(stories.length + 1);
  expect(ids.roots.length).toBe(stories.length + 1);
  expect(own(ids.anchors).sort()).toEqual(stories);
  expect(own(ids.roots).sort()).toEqual(stories);
  const ready = await docsReadiness(page, stories.length, 0);
  expect(ready.innerRoots).toBeGreaterThanOrEqual(stories.length);
  expect(ready.ready).toBe(true);
});

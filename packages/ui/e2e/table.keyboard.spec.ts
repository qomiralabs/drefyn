import type { Locator, Page } from '@playwright/test';
import { tokens } from '../src/index.ts';
import { expect, MOBILE, openStory, rgb, tabKey, test, THEMES } from './fixtures.ts';

const grid = (page: Page) => page.getByRole('grid', { name: 'Pages' });
const row = (page: Page, title: string) =>
  grid(page)
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: new RegExp(`^${title}`) }) });
const output = (page: Page) => page.getByText(/^Last opened: /);
const ringOf = (el: Locator) =>
  el.evaluate((node) => {
    const style = getComputedStyle(node);
    return `${style.outlineStyle} ${style.outlineWidth} ${style.outlineOffset} ${style.outlineColor}`;
  });
const titles = (page: Page) => grid(page).getByRole('rowheader').allTextContents();

for (const theme of THEMES) {
  const inset = `solid ${tokens.stroke.focus}px ${tokens.stroke.focusInset}px ${rgb(tokens.color.focus.ring[theme])}`;

  test(`Tab lands on the first row with the inset ring and the arrows move by row in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-table--default', theme);
    await page.keyboard.press(tabKey(browserName));
    const first = row(page, 'Refunds');
    await expect(first).toBeFocused();
    await expect.poll(() => ringOf(first)).toBe(inset);
    await page.keyboard.press('ArrowDown');
    await expect(row(page, 'Create a payout')).toBeFocused();
    await page.keyboard.press('End');
    await expect(row(page, 'Webhooks')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(first).toBeFocused();
  });

  test(`the table exposes its name, headers, sort state and rows in ${theme}`, async ({ page }) => {
    await openStory(page, 'components-table--default', theme);
    await expect(grid(page)).toMatchAriaSnapshot(`
      - grid "Pages":
        - rowgroup:
          - row "Page Views Edited":
            - columnheader "Page"
            - columnheader "Views"
            - columnheader "Edited"
        - rowgroup:
          - row "Refunds":
            - rowheader "Refunds"
            - gridcell "1,204"
            - gridcell "2 hours ago"
          - row "Create a payout":
            - rowheader "Create a payout"
            - gridcell "4,800"
            - gridcell "Yesterday"
          - row "API keys":
            - rowheader "API keys"
            - gridcell "960"
            - gridcell "21 Oct"
          - row "Webhooks":
            - rowheader "Webhooks"
            - gridcell "88"
            - gridcell "14 Oct"
    `);
  });

  test(`the grid is one Tab stop in ${theme}`, async ({ page, browserName }) => {
    await openStory(page, 'components-table--default', theme);
    await page.keyboard.press(tabKey(browserName));
    await expect(row(page, 'Refunds')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press(tabKey(browserName));
    await expect(page.getByRole('button', { name: 'Load more' })).toBeFocused();
    await page.keyboard.press(`Shift+${tabKey(browserName)}`);
    await expect(row(page, 'Create a payout')).toBeFocused();
  });

  test(`Enter opens the focused row in ${theme}`, async ({ page, browserName }) => {
    await openStory(page, 'components-table--default', theme);
    await page.keyboard.press(tabKey(browserName));
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(output(page)).toHaveText('Last opened: Create a payout');
  });

  test(`the arrows reach a sortable header and Enter sorts by it in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-table--default', theme);
    await page.keyboard.press(tabKey(browserName));
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowUp');
    const views = page.getByRole('columnheader', { name: /^Views/ });
    await expect(views).toBeFocused();
    await expect.poll(() => ringOf(views)).toBe(inset);
    await expect(views).toHaveAttribute('aria-sort', 'none');
    await page.keyboard.press('Enter');
    await expect(views).toHaveAttribute('aria-sort', 'ascending');
    expect((await titles(page))[0]).toMatch(/^Webhooks/);
    await page.keyboard.press('Enter');
    await expect(views).toHaveAttribute('aria-sort', 'descending');
    expect((await titles(page))[0]).toMatch(/^Create a payout/);
  });

  test(`Space selects the focused row and the count is announced in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-table--selection', theme);
    // The story starts sorted by views, most first.
    await page.keyboard.press(tabKey(browserName));
    await expect(row(page, 'Create a payout')).toBeFocused();
    await page.keyboard.press('Space');
    await expect(row(page, 'Create a payout')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(row(page, 'Refunds')).toBeFocused();
    await page.keyboard.press('Space');
    await expect(row(page, 'Refunds')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[role="status"]')).toHaveText('2 selected');
    await page.keyboard.press('Space');
    await expect(row(page, 'Refunds')).toHaveAttribute('aria-selected', 'false');
    await expect(page.locator('[role="status"]')).toHaveText('1 selected');
  });

  test(`a disabled row is reached by the arrows, reads its reason and is never selected in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-table--disabled-rows', theme);
    await page.keyboard.press(tabKey(browserName));
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    const locked = row(page, 'API keys');
    await expect(locked).toBeFocused();
    await expect(locked.getByRole('checkbox')).toHaveAttribute('aria-disabled', 'true');
    await expect(locked).toContainText('Managed by the API reference');
    await page.keyboard.press('Space');
    await page.keyboard.press('Enter');
    await expect(locked).not.toHaveAttribute('aria-selected', 'true');
    await expect(output(page)).toHaveText('Last opened: none');
    await page.keyboard.press('ArrowDown');
    await expect(row(page, 'Webhooks')).toBeFocused();
  });

  test(`a loading table is busy and keeps its header in ${theme}`, async ({ page }) => {
    await openStory(page, 'components-table--loading', theme);
    await expect(grid(page)).toHaveAttribute('aria-busy', 'true');
    await expect(grid(page).getByRole('columnheader')).toHaveCount(3);
    // React Aria draws the loading rows in one row of its own; no page row is there.
    await expect(grid(page).getByRole('rowheader')).toHaveText(['Loading pages']);
  });
}

// At 390 px the frame scrolls sideways instead of squeezing columns, and the keyboard path
// is the same.
test.describe('on a phone', () => {
  test.use({ viewport: MOBILE });

  test('the arrows still move by row and the page itself never scrolls sideways', async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-table--default', 'light');
    await page.keyboard.press(tabKey(browserName));
    await page.keyboard.press('ArrowDown');
    await expect(row(page, 'Create a payout')).toBeFocused();
    const wide = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(wide).toBe(false);
  });
});

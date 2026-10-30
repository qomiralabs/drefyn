import type { Page } from '@playwright/test';
import { tokens } from '../src/index.ts';
import { expect, openStory, rgb, tabKey, test, THEMES } from './fixtures.ts';

const tab = (page: Page, name: string) => page.getByRole('tab', { name: new RegExp(`^${name}`) });
const panel = (page: Page) => page.getByRole('tabpanel');

const ringOf = (page: Page, name: string) =>
  tab(page, name).evaluate((el) => {
    const style = getComputedStyle(el);
    return `${style.outlineStyle} ${style.outlineWidth} ${style.outlineOffset} ${style.outlineColor}`;
  });

for (const theme of THEMES) {
  const inset = `solid ${tokens.stroke.focus}px ${tokens.stroke.focusInset}px ${rgb(tokens.color.focus.ring[theme])}`;

  test(`Tab enters on the selected tab, the arrows select and Tab moves into the panel in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-tabs--default', theme);
    await expect(page.locator('#storybook-root')).toMatchAriaSnapshot(`
      - tablist "Site views":
        - tab "Pages" [selected]
        - tab "Out of date"
        - tab "History"
      - tabpanel "Pages"
    `);
    await page.keyboard.press(tabKey(browserName));
    await expect(tab(page, 'Pages')).toBeFocused();
    await expect.poll(() => ringOf(page, 'Pages')).toBe(inset);
    await page.keyboard.press('ArrowRight');
    await expect(tab(page, 'Out of date')).toBeFocused();
    await expect(tab(page, 'Out of date')).toHaveAttribute('aria-selected', 'true');
    await expect(panel(page)).toHaveText('Pages the agent flagged since the last publish.');
    await page.keyboard.press('End');
    await expect(tab(page, 'History')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(tab(page, 'Pages')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(tab(page, 'History')).toBeFocused();
    await page.keyboard.press(tabKey(browserName));
    await expect(panel(page)).toBeFocused();
    await expect(panel(page)).toHaveAccessibleName('History');
  });

  test(`manual tabs wait for Enter before showing a panel in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-tabs--manual', theme);
    await page.keyboard.press(tabKey(browserName));
    await page.keyboard.press('ArrowRight');
    await expect(tab(page, 'Affected components')).toBeFocused();
    await expect(panel(page)).toHaveText('Updates in the order they were posted.');
    await page.keyboard.press('Enter');
    await expect(panel(page)).toHaveText('Components this incident marks as degraded.');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Space');
    await expect(panel(page)).toHaveText('People who get an email for each update.');
  });

  test(`the arrows reach a disabled tab with the ring but never show its panel in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-tabs--disabled', theme);
    await page.keyboard.press(tabKey(browserName));
    await page.keyboard.press('ArrowRight');
    const drafts = tab(page, 'Drafts');
    await expect(drafts).toBeFocused();
    await expect(drafts).toHaveAttribute('aria-disabled', 'true');
    await expect.poll(() => ringOf(page, 'Drafts')).toBe(inset);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await drafts.click({ force: true });
    await expect(tab(page, 'Pages')).toHaveAttribute('aria-selected', 'true');
    await expect(panel(page)).toHaveText('Drafts open once the site has a reviewer.');
    await page.keyboard.press('ArrowRight');
    await expect(tab(page, 'History')).toBeFocused();
    await expect(panel(page)).toHaveText('Every publish, with who approved it.');
  });

  test(`counts read in tabular figures in ${theme}`, async ({ page }) => {
    await openStory(page, 'components-tabs--with-counts', theme);
    const count = tab(page, 'Pages').locator('[data-numeric]');
    await expect(count).toHaveText('1,284');
    await expect(count).toHaveCSS('font-variant-numeric', 'tabular-nums');
  });
}

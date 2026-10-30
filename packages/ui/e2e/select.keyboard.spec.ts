import type { Page } from '@playwright/test';
import { tokens } from '../src/index.ts';
import { docsEntry, expect, openPage, openStory, rgb, tabKey, test, THEMES } from './fixtures.ts';

const trigger = (page: Page, label = 'Region') =>
  page.getByRole('button', { name: new RegExp(`^${label}`) });
const option = (page: Page, name: string) =>
  page.getByRole('option', { name: new RegExp(`^${name}`) });

const ringOf = (page: Page, label = 'Region') =>
  trigger(page, label).evaluate((el) => {
    const style = getComputedStyle(el);
    return `${style.outlineStyle} ${style.outlineWidth} ${style.outlineOffset} ${style.outlineColor}`;
  });

// A select that starts open is modal, so on the docs page it would hide everything else.
test('the select docs page opens no list and leaves every heading readable', async ({ page }) => {
  await openPage(page, docsEntry('components-select--docs'), 'light');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: / Open$/ })).toBeVisible();
  await expect(page.locator('#storybook-docs')).not.toHaveAttribute('aria-hidden', 'true');
});

for (const theme of THEMES) {
  const ring = `solid ${tokens.stroke.focus}px ${tokens.stroke.focusOffset}px ${rgb(tokens.color.focus.ring[theme])}`;

  test(`Tab reaches the trigger with the ring, the arrows choose and Escape returns focus in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-select--default', theme);
    await page.keyboard.press(tabKey(browserName));
    await expect(trigger(page)).toBeFocused();
    await expect(trigger(page)).toHaveAccessibleDescription('Pages are served from here.');
    await expect.poll(() => ringOf(page)).toBe(ring);
    await page.keyboard.press('ArrowDown');
    const list = page.getByRole('listbox');
    await expect(list).toBeVisible();
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(option(page, 'Europe')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(option(page, 'United States')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(list).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
    await expect(trigger(page)).toContainText('United States');
    await page.keyboard.press('Enter');
    await expect(option(page, 'United States')).toBeFocused();
    await expect(option(page, 'United States')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
    await expect(trigger(page)).toContainText('United States');
  });

  test(`the arrows pass through a disabled option, which Enter does not choose in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-select--default', theme);
    await page.keyboard.press(tabKey(browserName));
    await page.keyboard.press('Enter');
    await expect(option(page, 'Europe')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    const ap = option(page, 'Asia Pacific');
    await expect(ap).toBeFocused();
    await expect(ap).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('listbox')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect(option(page, 'South America')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(ap).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(trigger(page)).toContainText('Choose a region');
  });

  test(`Home, End and a typed letter move within the open list in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-select--default', theme);
    await page.keyboard.press(tabKey(browserName));
    await page.keyboard.press('Space');
    await page.keyboard.press('End');
    await expect(option(page, 'South America')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(option(page, 'Europe')).toBeFocused();
    await page.keyboard.press('u');
    await expect(option(page, 'United States')).toBeFocused();
  });

  test(`opening and closing at once leaves no list behind in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-select--default', theme);
    await page.keyboard.press(tabKey(browserName));
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
  });

  test(`a disabled select is reached by Tab, reads its reason and never opens in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-select--disabled', theme);
    const el = trigger(page, 'Data region');
    await page.keyboard.press(tabKey(browserName));
    await expect(el).toBeFocused();
    await expect(el).toHaveAttribute('aria-disabled', 'true');
    await expect(el).toHaveAccessibleDescription('The region is fixed once the site has pages.');
    await expect.poll(() => ringOf(page, 'Data region')).toBe(ring);
    for (const key of ['Enter', 'Space', 'ArrowDown', 'u']) await page.keyboard.press(key);
    await el.click({ force: true });
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(el).toContainText('Europe');
  });

  test(`an invalid select names its error in its description in ${theme}`, async ({ page }) => {
    await openStory(page, 'components-select--invalid', theme);
    await expect(trigger(page, 'Plan')).toHaveAccessibleDescription(
      /Choose a plan to start the trial\./,
    );
  });

  test(`a loading list is busy and shows no options in ${theme}`, async ({ page }) => {
    await openStory(page, 'components-select--loading', theme);
    const list = page.getByRole('listbox');
    await expect(list).toBeVisible();
    await expect(list).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('option')).toHaveCount(0);
  });
}

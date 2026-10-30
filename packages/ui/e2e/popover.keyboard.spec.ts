import type { Page } from '@playwright/test';
import { expect, openStory, tabKey, test, THEMES } from './fixtures.ts';

const ROW = 'components-popover--in-a-row';
const trigger = (page: Page) => page.getByRole('button', { name: 'Filters' });
const panel = (page: Page) => page.getByRole('dialog', { name: 'Filter pages' });

async function openInRow(page: Page, browserName: string, key = 'Enter') {
  await page.keyboard.press(tabKey(browserName));
  await expect(page.getByRole('button', { name: 'Edit page' })).toBeFocused();
  await page.keyboard.press(tabKey(browserName));
  await expect(trigger(page)).toBeFocused();
  await page.keyboard.press(key);
  await expect(panel(page)).toBeVisible();
}

for (const theme of THEMES) {
  test(`Enter opens with focus in the panel and Escape returns it to the trigger in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, ROW, theme);
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
    await openInRow(page, browserName);
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(panel(page)).toBeFocused();
    await expect(panel(page).getByRole('heading', { name: 'Filter pages' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
  });

  test(`Space opens it too in ${theme}`, async ({ page, browserName }) => {
    await openStory(page, ROW, theme);
    await openInRow(page, browserName, 'Space');
  });

  test(`Tab walks the panel, then leaves it closed and moves on from the trigger in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, ROW, theme);
    await openInRow(page, browserName);
    await page.keyboard.press(tabKey(browserName));
    await expect(page.getByRole('switch', { name: 'Only stale pages' })).toBeFocused();
    await page.keyboard.press(tabKey(browserName));
    await expect(page.getByRole('switch', { name: 'Only pages with drafts' })).toBeFocused();
    await expect(panel(page)).toBeVisible();
    await page.keyboard.press(tabKey(browserName));
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Share page' })).toBeFocused();
  });

  test(`Shift+Tab before the first control closes it on the trigger in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, ROW, theme);
    await openInRow(page, browserName);
    await page.keyboard.press(tabKey(browserName));
    await expect(page.getByRole('switch', { name: 'Only stale pages' })).toBeFocused();
    await page.keyboard.press(`Shift+${tabKey(browserName)}`);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
    await page.keyboard.press(`Shift+${tabKey(browserName)}`);
    await expect(page.getByRole('button', { name: 'Edit page' })).toBeFocused();
  });

  test(`Shift+Tab from the panel itself closes it on the trigger in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, ROW, theme);
    await openInRow(page, browserName);
    await page.keyboard.press(`Shift+${tabKey(browserName)}`);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
  });

  test(`a press outside closes it and nothing on the page is hidden while open in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, ROW, theme);
    await openInRow(page, browserName);
    await expect(page.getByRole('button', { name: 'Share page' })).toBeVisible();
    await expect(page.locator('#storybook-root')).not.toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('[inert]')).toHaveCount(0);
    await page.mouse.click(4, 4);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
  });

  test(`a click on the switch inside keeps it open in ${theme}`, async ({ page }) => {
    await openStory(page, ROW, theme);
    await trigger(page).click();
    await page.getByText('Only pages with drafts', { exact: true }).click();
    await expect(panel(page)).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Only pages with drafts' })).toBeChecked();
  });

  test(`an icon trigger names the panel it opens in ${theme}`, async ({ page, browserName }) => {
    await openStory(page, 'components-popover--icon-trigger', theme);
    await page.keyboard.press(tabKey(browserName));
    const button = page.getByRole('button', { name: 'Page details' });
    await expect(button).toBeFocused();
    await expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Page details' })).toBeFocused();
    await page.keyboard.press(tabKey(browserName));
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
}

import type { Locator, Page } from '@playwright/test';
import { tokens } from '../src/index.ts';
import { expect, openPage, openStory, rgb, tabKey, test, THEMES } from './fixtures.ts';

const STORY = 'components-menu--default';
const ROW = 'components-menu--in-a-row';
const trigger = (page: Page) => page.getByRole('button', { name: 'Payments API' });
const item = (page: Page, name: string) => page.getByRole('menuitem', { name });
const output = (page: Page) => page.getByText(/^Last action: /);

const look = (el: Locator) =>
  el.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      fill: style.backgroundColor,
      ring: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineOffset} ${style.outlineColor}`,
      opacity: style.opacity,
    };
  });

async function openWith(page: Page, browserName: string, key: string) {
  await page.keyboard.press(tabKey(browserName));
  await expect(trigger(page)).toBeFocused();
  await page.keyboard.press(key);
  await expect(page.getByRole('menu', { name: 'Payments API' })).toBeVisible();
}

// Tab past the control before the trigger, then open with Enter.
async function openInRow(page: Page, browserName: string) {
  await page.keyboard.press(tabKey(browserName));
  await expect(page.getByRole('button', { name: 'Edit component' })).toBeFocused();
  await page.keyboard.press(tabKey(browserName));
  await expect(trigger(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(item(page, 'Open monitor')).toBeFocused();
}

// A menu that starts open is modal, so on the docs page it would hide everything else.
test('the menu docs page opens no menu and leaves every heading readable', async ({ page }) => {
  await openPage(page, { id: 'components-menu--docs', type: 'docs' }, 'light');
  await expect(page.getByRole('menu')).toHaveCount(0);
  // Storybook names each story heading with its anchor link first.
  await expect(page.getByRole('heading', { name: / Open$/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: / Sections$/ })).toBeVisible();
  // An open modal menu marks everything outside it aria-hidden, the docs included.
  await expect(page.locator('#storybook-docs')).not.toHaveAttribute('aria-hidden', 'true');
});

for (const theme of THEMES) {
  const inset = `solid ${tokens.stroke.focus}px ${tokens.stroke.focusInset}px ${rgb(tokens.color.focus.ring[theme])}`;

  test(`Enter opens on the first item and the arrows pass through the disabled item in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, STORY, theme);
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
    await openWith(page, browserName, 'Enter');
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(item(page, 'Open monitor')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(item(page, 'Start incident')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    const disabled = item(page, 'Hide from audience');
    await expect(disabled).toBeFocused();
    await expect(disabled).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(item(page, 'Copy ID')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(disabled).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(item(page, 'Start incident')).toBeFocused();
  });

  test(`a focused disabled item ignores Enter and Space, keeps the menu open and takes no fill in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, STORY, theme);
    await openWith(page, browserName, 'Enter');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    const disabled = item(page, 'Hide from audience');
    await expect(disabled).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await expect(disabled).toBeFocused();
    await expect(output(page)).toHaveText('Last action: none');
    const seen = await look(disabled);
    expect(seen.fill).not.toBe(rgb(tokens.color.surface.hover[theme]));
    expect(seen.fill).not.toBe(rgb(tokens.color.surface.pressed[theme]));
    expect(seen.opacity).toBe('1');
    await expect(disabled).toHaveCSS('color', rgb(tokens.color.disabled.text[theme]));
  });

  test(`the focused item shows the hover fill and the inset ring in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, STORY, theme);
    await openWith(page, browserName, 'Enter');
    await page.keyboard.press('ArrowDown');
    const focused = item(page, 'Start incident');
    await expect(focused).toBeFocused();
    await expect
      .poll(() => look(focused))
      .toEqual({ fill: rgb(tokens.color.surface.hover[theme]), ring: inset, opacity: '1' });
  });

  test(`Enter runs an item, closes the menu and returns focus to the trigger in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, STORY, theme);
    await openWith(page, browserName, 'Enter');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(output(page)).toHaveText('Last action: Start incident');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test(`Escape closes the menu and returns focus to the trigger in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, STORY, theme);
    await openWith(page, browserName, 'Space');
    await expect(item(page, 'Open monitor')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
    await expect(output(page)).toHaveText('Last action: none');
  });

  test(`Tab closes the menu and moves on from the trigger, without running anything, in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, ROW, theme);
    await openInRow(page, browserName);
    await page.keyboard.press(tabKey(browserName));
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Share page' })).toBeFocused();
    await expect(output(page)).toHaveText('Last action: none');
  });

  test(`Shift+Tab closes the menu and moves back from the trigger in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, ROW, theme);
    await openInRow(page, browserName);
    await page.keyboard.press(`Shift+${tabKey(browserName)}`);
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Edit component' })).toBeFocused();
    await expect(output(page)).toHaveText('Last action: none');
  });

  test(`ArrowDown opens on the first item and ArrowUp on the last in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, STORY, theme);
    await openWith(page, browserName, 'ArrowDown');
    await expect(item(page, 'Open monitor')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(trigger(page)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(item(page, 'Copy ID')).toBeFocused();
  });

  test(`Home, End and typing a letter move through the items in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, STORY, theme);
    await openWith(page, browserName, 'Enter');
    await page.keyboard.press('End');
    await expect(item(page, 'Copy ID')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(item(page, 'Open monitor')).toBeFocused();
    await page.keyboard.press('c');
    await expect(item(page, 'Copy ID')).toBeFocused();
  });

  test(`the open menu exposes its name, items and the unavailable one in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, STORY, theme);
    await openWith(page, browserName, 'Enter');
    await expect(page.getByRole('menu', { name: 'Payments API' })).toMatchAriaSnapshot(`
      - menu "Payments API":
        - menuitem "Open monitor"
        - menuitem "Start incident"
        - menuitem "Hide from audience" [disabled]
        - menuitem "Copy ID"
    `);
    // Aria snapshots do not print aria-keyshortcuts, so the shortcut is read directly.
    await expect(item(page, 'Open monitor')).toHaveAttribute('aria-keyshortcuts', 'O');
    await expect(item(page, 'Start incident')).toHaveAttribute('aria-keyshortcuts', 'I');
    await expect(item(page, 'Copy ID')).not.toHaveAttribute('aria-keyshortcuts', /.*/);
  });

  test(`an icon trigger is named, opens by keyboard and returns focus in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-menu--icon-trigger', theme);
    const button = page.getByRole('button', { name: 'Actions for Checkout' });
    await page.keyboard.press(tabKey(browserName));
    await expect(button).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: 'Open monitor' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(button).toBeFocused();
  });
}

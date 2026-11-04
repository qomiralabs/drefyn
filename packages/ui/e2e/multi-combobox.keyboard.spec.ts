import type { Page } from '@playwright/test';
import {
  docsEntry,
  expect,
  MOBILE,
  openPage,
  openStory,
  tabKey,
  test,
  THEMES,
} from './fixtures.ts';
import { expectSheet, pressScrim } from './sheet.ts';

const input = (page: Page) => page.getByRole('combobox', { name: 'Projects' });
const chip = (page: Page, name: string) => page.getByRole('row', { name });
const option = (page: Page, name: string) =>
  page.getByRole('option', { name: new RegExp(`^${name}`) });
const list = (page: Page) => page.getByRole('listbox');

// The active option, which focus never reaches: the input keeps focus and points at it.
const expectActive = (page: Page, name: string) =>
  expect
    .poll(() =>
      input(page).evaluate((el) => {
        const id = el.getAttribute('aria-activedescendant');
        return id === null ? null : (document.getElementById(id)?.textContent ?? null);
      }),
    )
    .toContain(name);

// A list that starts open floats over the page, so a docs page never starts one.
test('the docs page opens no list', async ({ page }) => {
  await openPage(page, docsEntry('components-multi-combobox--docs'), 'light');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(page.locator('#storybook-docs')).not.toHaveAttribute('aria-hidden', 'true');
});

for (const theme of THEMES) {
  test(`the arrows move, Enter picks and stays open, Escape closes and keeps focus in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-multi-combobox--default', theme);
    await page.keyboard.press(tabKey(browserName));
    await expect(input(page)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(option(page, 'Payments API docs')).toBeVisible();
    await expect(list(page)).toHaveAttribute('aria-multiselectable', 'true');
    await expectActive(page, 'Payments API docs');
    await page.keyboard.press('ArrowDown');
    await expectActive(page, 'Partner API docs');
    await page.keyboard.press('Enter');
    await expect(chip(page, 'Partner API docs')).toBeVisible();
    await expect(list(page)).toBeVisible();
    await expect(option(page, 'Partner API docs')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowUp');
    await expectActive(page, 'Payments API docs');
    await page.keyboard.press('Enter');
    await expect(chip(page, 'Payments API docs')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('row', { name: 'Payments API docs' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(list(page)).toHaveCount(0);
    await expect(input(page)).toBeFocused();
    await expect(page.getByRole('row')).toHaveCount(1);
  });

  test(`typing filters, a pick keeps the search and the count follows in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-multi-combobox--default', theme);
    await page.keyboard.press(tabKey(browserName));
    await expect(input(page)).toBeFocused();
    await page.keyboard.type('docs');
    await expect(page.getByRole('option')).toHaveCount(2);
    await expect(page.getByText('2 of 4 projects match docs')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expectActive(page, 'Payments API docs');
    await page.keyboard.press('Enter');
    await expect(chip(page, 'Payments API docs')).toBeVisible();
    await expect(input(page)).toHaveValue('docs');
    await expect(page.getByRole('option')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(input(page)).toHaveValue('');
  });

  test(`the arrows pass through a disabled option, which Enter does not pick in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-multi-combobox--default', theme);
    await page.keyboard.press(tabKey(browserName));
    await expect(input(page)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(page.getByRole('option')).toHaveCount(4);
    await expectActive(page, 'Old site');
    await expect(option(page, 'Old site')).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Enter');
    await expect(list(page)).toBeVisible();
    await expect(page.getByRole('row')).toHaveCount(0);
    await page.keyboard.press('ArrowUp');
    await expectActive(page, 'Status page');
  });

  // In a dialog, since a field last on the page has nowhere for Tab to go in Firefox.
  test(`Tab closes the list without picking and moves on in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-multi-combobox--in-a-dialog', theme);
    await page.getByRole('button', { name: 'Create key' }).click();
    await expect(page.getByRole('row')).toHaveCount(1);
    await input(page).focus();
    await page.keyboard.press('ArrowDown');
    await expectActive(page, 'Payments API docs');
    await page.keyboard.press(tabKey(browserName));
    await expect(list(page)).toHaveCount(0);
    await expect(input(page)).not.toBeFocused();
    await expect(page.getByRole('dialog', { name: 'Create an API key' })).toBeVisible();
    await expect(page.getByRole('row')).toHaveCount(1);
  });

  test(`Shift Tab from an open list lands on the last chip button in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-multi-combobox--chosen', theme);
    await expect(page.getByRole('row')).toHaveCount(2);
    await input(page).focus();
    await page.keyboard.press('ArrowDown');
    await expect(list(page)).toBeVisible();
    await page.keyboard.press(`Shift+${tabKey(browserName)}`);
    await expect(list(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Remove Partner/ })).toBeFocused();
  });

  test(`Backspace steps onto the last chip, removes it and reaches the input in ${theme}`, async ({
    page,
  }) => {
    await openStory(page, 'components-multi-combobox--chosen', theme);
    await expect(page.getByRole('row')).toHaveCount(2);
    await input(page).focus();
    await page.keyboard.press('Backspace');
    await expect(chip(page, 'Partner API docs')).toBeFocused();
    await page.keyboard.press('Backspace');
    await expect(chip(page, 'Payments API docs')).toBeFocused();
    await page.keyboard.press('Backspace');
    await expect(page.getByRole('row')).toHaveCount(0);
    await expect(input(page)).toBeFocused();
  });

  test(`a list with nothing to show says so and stays open in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-multi-combobox--default', theme);
    await page.keyboard.press(tabKey(browserName));
    await expect(input(page)).toBeFocused();
    await page.keyboard.type('zzz');
    await expect(list(page)).toContainText('No projects match');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('row')).toHaveCount(0);
  });

  test(`a loading list is busy and shows no options in ${theme}`, async ({ page }) => {
    await openStory(page, 'components-multi-combobox--loading', theme);
    await expect(list(page)).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('option')).toHaveText(['Loading options']);
  });

  test(`a disabled field is reached by Tab, reads its reason and never opens in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-multi-combobox--disabled', theme);
    await expect(page.getByRole('row')).toHaveCount(1);
    await page.keyboard.press(tabKey(browserName));
    await page.keyboard.press(tabKey(browserName));
    const el = input(page);
    await expect(el).toBeFocused();
    await expect(el).toHaveAttribute('aria-disabled', 'true');
    await expect(el).toHaveAccessibleDescription('Only an owner can change what a key reaches.');
    for (const key of ['ArrowDown', 'd', 'Enter', 'Backspace']) await page.keyboard.press(key);
    await el.click({ force: true });
    await expect(list(page)).toHaveCount(0);
    await expect(page.getByRole('row')).toHaveCount(1);
  });

  test(`Escape in a dialog closes the list first and the dialog next in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-multi-combobox--in-a-dialog', theme);
    const open = page.getByRole('button', { name: 'Create key' });
    await page.keyboard.press(tabKey(browserName));
    await expect(open).toBeFocused();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Create an API key' });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('row')).toHaveCount(1);
    await expect(input(page)).toBeVisible();
    await input(page).focus();
    await page.keyboard.press('ArrowDown');
    await expect(list(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(list(page)).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(input(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(open).toBeFocused();
  });
}

// A press on the list lands outside the dialog in the page, and must not count as outside it.
test('a press on an option in a dialog adds a chip and leaves the dialog open', async ({
  page,
}) => {
  await openStory(page, 'components-multi-combobox--in-a-dialog', 'light');
  await page.getByRole('button', { name: 'Create key' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create an API key' });
  await expect(dialog).toBeVisible();
  await input(page).click();
  await option(page, 'Status page').click();
  await expect(chip(page, 'Status page')).toBeVisible();
  await expect(list(page)).toBeVisible();
  await expect(dialog).toBeVisible();
});

// Below the small breakpoint the list and its search open in the shared sheet.
test.describe('on a phone', () => {
  test.use({ viewport: MOBILE });

  const trigger = (page: Page) => page.getByRole('button', { name: /^Projects/ });

  for (const theme of THEMES) {
    test(`the sheet holds the search and the list, and Escape returns focus in ${theme}`, async ({
      page,
      browserName,
    }) => {
      await openStory(page, 'components-multi-combobox--default', theme);
      await page.keyboard.press(tabKey(browserName));
      await expect(trigger(page)).toBeFocused();
      await page.keyboard.press('Enter');
      await expectSheet(page, 'Projects', 'option');
      await expect(page.getByRole('textbox', { name: 'Search projects' })).toBeFocused();
      await page.keyboard.type('docs');
      await expect(page.getByRole('option')).toHaveCount(2);
      // Typing makes the first match active.
      await page.keyboard.press('Enter');
      await expect(option(page, 'Payments API docs')).toHaveAttribute('aria-selected', 'true');
      await expect(list(page)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-sheet]')).toHaveCount(0);
      await expect(trigger(page)).toBeFocused();
      await expect(chip(page, 'Payments API docs')).toBeVisible();
    });

    test(`a press on the scrim closes the sheet and keeps the picks in ${theme}`, async ({
      page,
    }) => {
      await openStory(page, 'components-multi-combobox--default', theme);
      await trigger(page).click();
      await expectSheet(page, 'Projects');
      await option(page, 'Status page').click();
      await pressScrim(page);
      await expect(list(page)).toHaveCount(0);
      await expect(trigger(page)).toBeFocused();
      await expect(chip(page, 'Status page')).toBeVisible();
    });

    test(`in a dialog the sheet opens over it and closes back to it in ${theme}`, async ({
      page,
      browserName,
    }) => {
      await openStory(page, 'components-multi-combobox--in-a-dialog', theme);
      const open = page.getByRole('button', { name: 'Create key' });
      await page.keyboard.press(tabKey(browserName));
      await expect(open).toBeFocused();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Create an API key' });
      await expect(dialog).toBeVisible();
      await expect(trigger(page)).toBeVisible();
      await trigger(page).focus();
      await page.keyboard.press('Enter');
      await expectSheet(page, 'Projects', 'option');
      await expect(page.locator('[role="dialog"]')).toHaveCount(2);
      await page.keyboard.press('Escape');
      await expect(list(page)).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await expect(trigger(page)).toBeFocused();
      // Escape shut the sheet and left the pick alone.
      await expect(chip(page, 'Payments API docs')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(open).toBeFocused();
    });
  }
});

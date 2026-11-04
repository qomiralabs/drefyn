import type { Page } from '@playwright/test';
import { tokens } from '../src/index.ts';
import { expect, MOBILE, openStory, rgb, tabKey, test, THEMES } from './fixtures.ts';

const input = (page: Page, name = 'Email addresses') => page.getByRole('textbox', { name });
const chip = (page: Page, name: string | RegExp) => page.getByRole('row', { name });

const box = (page: Page, name = 'Email addresses') => page.getByRole('group', { name });

const ringOf = (page: Page) =>
  box(page).evaluate((el) => {
    const style = getComputedStyle(el);
    return `${style.outlineStyle} ${style.outlineWidth} ${style.outlineOffset} ${style.outlineColor}`;
  });

for (const theme of THEMES) {
  const ring = `solid ${tokens.stroke.focus}px ${tokens.stroke.focusOffset}px ${rgb(tokens.color.focus.ring[theme])}`;

  test(`Tab reaches the input with the ring on the box, Enter and a comma add in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-tag-field--default', theme);
    await page.keyboard.press(tabKey(browserName));
    await expect(input(page)).toBeFocused();
    await expect(input(page)).toHaveAccessibleDescription(/Enter or a comma adds each one/);
    await expect.poll(() => ringOf(page)).toBe(ring);
    await page.keyboard.type('kai@acme.dev');
    await page.keyboard.press('Enter');
    await expect(chip(page, 'kai@acme.dev')).toBeVisible();
    await page.keyboard.type('ren@acme.dev,');
    await expect(chip(page, 'ren@acme.dev')).toBeVisible();
    await expect(input(page)).toHaveValue('');
    await expect(input(page)).toBeFocused();
  });

  test(`Backspace steps onto the last chip, removes it and lands on the one before in ${theme}`, async ({
    page,
  }) => {
    await openStory(page, 'components-tag-field--filled', theme);
    await expect(page.getByRole('row')).toHaveCount(2);
    await input(page).focus();
    await page.keyboard.press('Backspace');
    const last = chip(page, 'ren@northwind.dev');
    await expect(last).toBeFocused();
    await expect.poll(() => last.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
    await page.keyboard.press('Backspace');
    await expect(page.getByRole('row')).toHaveCount(1);
    await expect(chip(page, 'kai@acme.dev')).toBeFocused();
    await page.keyboard.press('Delete');
    await expect(page.getByRole('row')).toHaveCount(0);
    await expect(input(page)).toBeFocused();
  });

  test(`the arrows move between chips and Tab goes by the chip button to the input in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-tag-field--filled', theme);
    await expect(page.getByRole('row')).toHaveCount(2);
    await page.keyboard.press(tabKey(browserName));
    await expect(chip(page, 'kai@acme.dev')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(chip(page, 'ren@northwind.dev')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(chip(page, 'kai@acme.dev')).toBeFocused();
    await page.keyboard.press(tabKey(browserName));
    await expect(page.getByRole('button', { name: /^Remove kai@acme\.dev/ })).toBeFocused();
    await page.keyboard.press(tabKey(browserName));
    await expect(input(page)).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(chip(page, 'ren@northwind.dev')).toBeFocused();
  });

  test(`a press on a chip button removes it and returns to the input in ${theme}`, async ({
    page,
  }) => {
    await openStory(page, 'components-tag-field--filled', theme);
    await page.getByRole('button', { name: /^Remove kai@acme\.dev/ }).click();
    await expect(page.getByRole('row')).toHaveCount(1);
    await expect(input(page)).toBeFocused();
  });

  test(`a chip with an error is named so and its message reads on the input in ${theme}`, async ({
    page,
  }) => {
    await openStory(page, 'components-tag-field--invalid-tags', theme);
    await expect(chip(page, /^lee\.k@acme, has an error/)).toBeVisible();
    await expect(input(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(input(page)).toHaveAccessibleDescription(/lee\.k@acme is not a full address/);
    await expect(input(page)).toHaveAccessibleDescription(/sam@acme\.dev is already in Acme/);
  });

  test(`a disabled field is reached by Tab, reads its reason and never changes in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-tag-field--disabled', theme);
    await expect(page.getByRole('row')).toHaveCount(1);
    await page.keyboard.press(tabKey(browserName));
    await page.keyboard.press(tabKey(browserName));
    const el = input(page);
    await expect(el).toBeFocused();
    await expect(el).toHaveAttribute('aria-disabled', 'true');
    await expect(el).toHaveAccessibleDescription('Invitations are closed on this plan.');
    await page.keyboard.type('ren@acme.dev,');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Backspace');
    await expect(page.getByRole('row')).toHaveCount(1);
    await expect(el).toHaveValue('');
  });

  test(`Enter in a dialog adds a chip and leaves the dialog open, and Escape closes it in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-tag-field--in-a-dialog', theme);
    await page.keyboard.press(tabKey(browserName));
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Invite people' });
    await expect(dialog).toBeVisible();
    await expect(input(page)).toBeFocused();
    await page.keyboard.type('kai@acme.dev');
    await page.keyboard.press('Enter');
    await expect(chip(page, 'kai@acme.dev')).toBeVisible();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
}

// The field keeps its input on a phone, since there is no list to open: the sheet is for lists.
test.describe('on a phone', () => {
  test.use({ viewport: MOBILE });

  for (const theme of THEMES) {
    test(`chips wrap inside the box and nothing scrolls sideways in ${theme}`, async ({ page }) => {
      await openStory(page, 'components-tag-field--invalid-tags', theme);
      await expect(page.getByRole('row')).toHaveCount(3);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBe(0);
      await expect(page.locator('[data-sheet]')).toHaveCount(0);
    });
  }
});

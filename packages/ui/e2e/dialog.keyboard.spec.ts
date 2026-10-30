import type { Page } from '@playwright/test';
import { tokens } from '../src/index.ts';
import { expect, MOBILE, openStory, rgb, tabKey, test, THEMES } from './fixtures.ts';

const trigger = (page: Page) => page.getByRole('button', { name: 'Invite people' });
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Invite people' });
const field = (page: Page, name: string) => page.getByRole('textbox', { name });

for (const theme of THEMES) {
  test(`Enter opens the dialog on its first field, Tab stays inside, Escape returns to the trigger in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-dialog--default', theme);
    await page.keyboard.press(tabKey(browserName));
    await expect(trigger(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toHaveAccessibleDescription(
      'They get an email with a link that works for seven days.',
    );
    await expect(field(page, 'Email addresses')).toBeFocused();
    const order = [
      field(page, 'Note'),
      page.getByRole('button', { name: 'Cancel' }),
      page.getByRole('button', { name: 'Send invites' }),
      page.getByRole('button', { name: 'Close' }),
      field(page, 'Email addresses'),
    ];
    for (const next of order) {
      await page.keyboard.press(tabKey(browserName));
      await expect(next).toBeFocused();
    }
    await page.keyboard.press(`Shift+${tabKey(browserName)}`);
    await expect(page.getByRole('button', { name: 'Close' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
  });

  test(`Space opens it too, and Cancel closes it in ${theme}`, async ({ page, browserName }) => {
    await openStory(page, 'components-dialog--default', theme);
    await page.keyboard.press(tabKey(browserName));
    await page.keyboard.press('Space');
    await expect(dialog(page)).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).focus();
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
  });

  test(`a click on the scrim keeps the dialog and what was typed in ${theme}`, async ({ page }) => {
    await openStory(page, 'components-dialog--open', theme);
    await field(page, 'Email addresses').fill('ada@example.com');
    await page.mouse.click(4, 4);
    await expect(dialog(page)).toBeVisible();
    await expect(field(page, 'Email addresses')).toHaveValue('ada@example.com');
  });

  test(`while a submit is in flight, Escape and the close button wait in ${theme}`, async ({
    page,
  }) => {
    await openStory(page, 'components-dialog--submitting', theme);
    await expect(dialog(page)).toHaveAttribute('aria-busy', 'true');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeVisible();
    const close = page.getByRole('button', { name: 'Close' });
    await close.focus();
    await expect(close).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeVisible();
    await expect(close).toHaveCSS('color', rgb(tokens.color.disabled.text[theme]));
  });

  test(`a failed submit puts focus on its message, before the fields, in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-dialog--failed', theme);
    const message = page.getByText('Could not send the invites. Nothing was sent; try again.');
    await expect(message).toBeVisible();
    await expect
      .poll(() => message.evaluate((el) => el.closest('[tabindex]') === document.activeElement))
      .toBe(true);
    await page.keyboard.press(tabKey(browserName));
    await expect(field(page, 'Email addresses')).toBeFocused();
    // Only the send failed; the address itself is not marked wrong.
    await expect(field(page, 'Email addresses')).not.toHaveAttribute('aria-invalid');
  });

  test(`with no field, focus lands on the dialog, which reads its title, in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-dialog--no-fields', theme);
    await page.keyboard.press(tabKey(browserName));
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Keyboard shortcuts' })).toBeFocused();
  });

  test(`the page behind is hidden from readers and the panel sits on the overlay surface in ${theme}`, async ({
    page,
  }) => {
    await openStory(page, 'components-dialog--open', theme);
    await expect(dialog(page)).toBeVisible();
    // React Aria makes everything outside the dialog inert, which also hides it from readers.
    await expect(page.locator('#storybook-root')).toHaveAttribute('inert', '');
    await expect(dialog(page)).toHaveCSS(
      'background-color',
      rgb(tokens.color.surface.overlay[theme]),
    );
  });

  test(`below 640 px the dialog rises from the bottom edge in ${theme}`, async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await openStory(page, 'components-dialog--open', theme);
    const box = await dialog(page).boundingBox();
    expect(box).not.toBeNull();
    if (box === null) return;
    expect(Math.round(box.x)).toBe(0);
    expect(Math.round(box.width)).toBe(MOBILE.width);
    expect(Math.round(box.y + box.height)).toBe(MOBILE.height);
  });
}

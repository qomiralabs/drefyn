import type { Page } from '@playwright/test';
import { tokens } from '../src/index.ts';
import { expect, openStory, tabKey, test, THEMES } from './fixtures.ts';

// The contract the shell relies on. React Aria's toast is UNSTABLE, so these pin its
// behaviour in every engine: an upgrade that changes it fails here, not for users.
const SHORT = tokens.timer.toast.ms;
const LONG = tokens.timer.toastUndo.ms;

const region = (page: Page) => page.getByRole('region', { name: /notification/i });
const card = (page: Page, title: string) => page.getByRole('alertdialog', { name: title });
const output = (page: Page) => page.getByText(/^Last action: /);

async function setHidden(page: Page, hidden: boolean) {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (value ? 'hidden' : 'visible'),
    });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

for (const theme of THEMES) {
  test(`a toast never takes focus from the button that showed it in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-toast--message', theme);
    const button = page.getByRole('button', { name: 'Copy ID' });
    await page.keyboard.press(tabKey(browserName));
    await expect(button).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alertdialog', { name: 'Copied the component ID' })).toHaveCount(2);
    await expect(button).toBeFocused();
  });

  test(`the toast announces through a status inside the notifications region in ${theme}`, async ({
    page,
  }) => {
    await openStory(page, 'components-toast--undo', theme);
    await expect(region(page)).toMatchAriaSnapshot(`
      - region:
        - list:
          - listitem:
            - alertdialog "Archived Pricing":
              - status:
                - text: Archived Pricing
                - text: Readers no longer see this page.
              - button "Undo"
              - button "Dismiss"
    `);
    await expect(card(page, 'Archived Pricing')).toHaveAccessibleDescription(
      'Readers no longer see this page.',
    );
  });

  test(`an error announces assertively and stays until dismissed by keyboard in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await page.clock.install();
    await openStory(page, 'components-toast--error-toast', theme);
    const error = card(page, 'Could not save the page');
    await expect(error.getByRole('alert')).toBeVisible();
    await page.clock.runFor(LONG * 3);
    await expect(error).toBeVisible();
    await page.keyboard.press('F6');
    await expect(error).toBeFocused();
    await page.keyboard.press(tabKey(browserName));
    await expect(error.getByRole('button', { name: 'Dismiss' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(error).toHaveCount(0);
  });

  test(`F6 reaches the toast, Undo runs once, and focus goes back where it was in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-toast--undo', theme);
    const back = page.getByRole('button', { name: 'Edit page' });
    await back.focus();
    await page.keyboard.press('F6');
    const toast = card(page, 'Archived Pricing');
    await expect(toast).toBeFocused();
    await page.keyboard.press(tabKey(browserName));
    await expect(toast.getByRole('button', { name: 'Undo' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(output(page)).toHaveText('Last action: Restored Pricing');
    await expect(toast).toHaveCount(0);
    await expect(back).toBeFocused();
  });

  test(`Cmd or Ctrl+Z runs Undo outside a text field, and never inside one, in ${theme}`, async ({
    page,
  }) => {
    await openStory(page, 'components-toast--undo', theme);
    await expect(card(page, 'Archived Pricing')).toBeVisible();
    // A text field takes its own undo.
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.setAttribute('aria-label', 'Scratch');
      document.querySelector('#storybook-root')?.append(input);
    });
    const scratch = page.getByRole('textbox', { name: 'Scratch' });
    await scratch.focus();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(card(page, 'Archived Pricing')).toBeVisible();
    await expect(output(page)).toHaveText('Last action: none');
    const button = page.getByRole('button', { name: 'Edit page' });
    await button.focus();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(output(page)).toHaveText('Last action: Restored Pricing');
    await expect(card(page, 'Archived Pricing')).toHaveCount(0);
    await expect(button).toBeFocused();
  });

  test(`the timer holds while the pointer is over the toast in ${theme}`, async ({ page }) => {
    await page.clock.install();
    await openStory(page, 'components-toast--message', theme);
    const toast = card(page, 'Copied the component ID');
    await expect(toast).toBeVisible();
    await toast.hover();
    await page.clock.runFor(SHORT * 2);
    await expect(toast).toBeVisible();
    await page.mouse.move(0, 0);
    await page.clock.runFor(SHORT + 100);
    await expect(toast).toHaveCount(0);
  });

  test(`the timer holds while focus is inside the toast in ${theme}`, async ({ page }) => {
    await page.clock.install();
    await openStory(page, 'components-toast--undo', theme);
    const toast = card(page, 'Archived Pricing');
    await toast.getByRole('button', { name: 'Undo' }).focus();
    await page.clock.runFor(LONG * 2);
    await expect(toast).toBeVisible();
    await page.getByRole('button', { name: 'Edit page' }).focus();
    await page.clock.runFor(LONG + 100);
    await expect(toast).toHaveCount(0);
  });

  test(`the timer holds while the tab is hidden in ${theme}`, async ({ page }) => {
    await page.clock.install();
    await openStory(page, 'components-toast--message', theme);
    const toast = card(page, 'Copied the component ID');
    await expect(toast).toBeVisible();
    await setHidden(page, true);
    await page.clock.runFor(SHORT * 3);
    await expect(toast).toBeVisible();
    await setHidden(page, false);
    await page.clock.runFor(SHORT + 100);
    await expect(toast).toHaveCount(0);
  });

  test(`toasts sit bottom left on wide screens and span the width at 390 px in ${theme}`, async ({
    page,
  }) => {
    await openStory(page, 'components-toast--stack', theme);
    const box = await region(page).boundingBox();
    const view = page.viewportSize();
    expect(box).not.toBeNull();
    expect(view).not.toBeNull();
    if (box === null || view === null) return;
    expect(box.x).toBeLessThan(view.width / 4);
    expect(box.x + box.width).toBeLessThan(view.width / 2 + view.width / 4);
    expect(view.height - (box.y + box.height)).toBeLessThanOrEqual(tokens.space[24] + 1);
    await page.setViewportSize({ width: 390, height: 844 });
    const narrow = await region(page).boundingBox();
    expect(narrow).not.toBeNull();
    if (narrow === null) return;
    expect(Math.round(narrow.x)).toBe(tokens.space[16]);
    expect(Math.round(390 - (narrow.x + narrow.width))).toBe(tokens.space[16]);
  });
}

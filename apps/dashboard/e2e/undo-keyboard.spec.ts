import { expect, type Page } from '@playwright/test';
import { test } from './csp.ts';
import { focused, focusedRegion, tabKey } from './fixtures.ts';
import { archive, openPages, pagesTable, row, toastRegion } from './undo-helpers.ts';

// The grid is one Tab stop that lands on the first row: down to a row, Space to choose.
async function chooseRefunds(page: Page, browserName: string): Promise<void> {
  await archive(page).focus();
  await page.keyboard.press(tabKey(browserName));
  await expect(row(page, 'Introduction')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await expect(row(page, 'Refunds').getByRole('checkbox')).toBeChecked();
}

test('archives from the keyboard alone, and focus stays on Archive', async ({
  page,
  browserName,
}) => {
  await openPages(page);
  await chooseRefunds(page, browserName);
  await archive(page).focus();
  await page.keyboard.press('Enter');
  await expect(row(page, 'Refunds')).toHaveCount(0);
  await expect(archive(page)).toBeFocused();
  await expect(archive(page)).toHaveAttribute('aria-disabled', 'true');
});

test('Cmd or Ctrl+Z undoes it without leaving the page', async ({ page, browserName }) => {
  await openPages(page);
  await chooseRefunds(page, browserName);
  await archive(page).focus();
  await page.keyboard.press('Enter');
  await expect(toastRegion(page).getByText('Archived Refunds.')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(row(page, 'Refunds')).toHaveCount(1);
  await expect(toastRegion(page).getByText('Refunds is back.')).toBeVisible();
  await expect(archive(page)).toBeFocused();
});

test('F6 reaches Undo, and focus lands on the page again after it', async ({
  page,
  browserName,
}) => {
  await openPages(page);
  await chooseRefunds(page, browserName);
  await archive(page).focus();
  await page.keyboard.press('Enter');
  await expect(toastRegion(page).getByText('Archived Refunds.')).toBeVisible();
  await expect
    .poll(async () => {
      await page.keyboard.press('F6');
      return focusedRegion(page);
    })
    .toBe('notifications');
  const undo = toastRegion(page).getByRole('button', { name: 'Undo' });
  for (let i = 0; i < 4 && !(await undo.evaluate((el) => el === document.activeElement)); i += 1) {
    await page.keyboard.press(tabKey(browserName));
  }
  await expect(undo).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(row(page, 'Refunds')).toHaveCount(1);
  await expect.poll(() => focused(page)).not.toBe('body');
});

test('choosing nothing leaves Archive reachable, with the reason beside it', async ({ page }) => {
  await openPages(page);
  await archive(page).focus();
  await expect(archive(page)).toBeFocused();
  await expect(archive(page)).toHaveAccessibleDescription(/Select some to archive/);
  await expect(pagesTable(page)).toBeVisible();
});

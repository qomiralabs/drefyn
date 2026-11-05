import { expect } from '@playwright/test';
import { MOBILE } from './fixtures.ts';
import { test } from './csp.ts';
import {
  archive,
  holdWrites,
  openPages,
  pagesTable,
  refuseWrites,
  row,
  select,
  selectAll,
  toastRegion,
} from './undo-helpers.ts';

const titles = async (page: Parameters<typeof pagesTable>[0]) =>
  pagesTable(page).getByRole('rowheader').allTextContents();

test.describe('archive with undo', () => {
  test('the row leaves before the server answers', async ({ page }) => {
    await openPages(page);
    const release = await holdWrites(page);
    await select(page, 'Refunds');
    await archive(page).click();
    await expect(row(page, 'Refunds')).toHaveCount(0);
    await expect(toastRegion(page).getByText('Archived Refunds.')).toBeVisible();
    await expect(toastRegion(page).getByRole('button', { name: 'Undo' })).toBeVisible();
    release();
  });

  test('Undo puts the rows back in their places', async ({ page }) => {
    await openPages(page);
    const before = await titles(page);
    await select(page, 'Refunds');
    await select(page, 'Errors');
    await archive(page).click();
    await expect(toastRegion(page).getByText('Archived 2 pages.')).toBeVisible();
    await expect(row(page, 'Refunds')).toHaveCount(0);
    await expect(row(page, 'Errors')).toHaveCount(0);
    await toastRegion(page).getByRole('button', { name: 'Undo' }).click();
    await expect(toastRegion(page).getByText('2 pages are back.')).toBeVisible();
    await expect.poll(() => titles(page)).toEqual(before);
  });

  test('a refused change rolls back, keeps the choice and says so', async ({ page }) => {
    await openPages(page);
    const before = await titles(page);
    await refuseWrites(page);
    await select(page, 'Refunds');
    await archive(page).click();
    const alert = toastRegion(page).getByRole('alert');
    await expect(alert).toContainText('Could not archive Refunds.');
    await expect(alert).toContainText('Nothing changed. Try again.');
    await expect.poll(() => titles(page)).toEqual(before);
    await expect(row(page, 'Refunds').getByRole('checkbox')).toBeChecked();
    await expect(toastRegion(page).getByRole('button', { name: 'Undo' })).toHaveCount(0);
  });

  test('a refused undo rolls forward again and says so', async ({ page }) => {
    await openPages(page);
    await select(page, 'Refunds');
    await archive(page).click();
    const undo = toastRegion(page).getByRole('button', { name: 'Undo' });
    await expect(undo).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-shell', 'ready');
    // Lets the archive land first, so only the undo meets the refusal.
    await page.waitForLoadState('networkidle');
    await refuseWrites(page);
    await undo.click();
    await expect(toastRegion(page).getByRole('alert')).toContainText('Could not undo');
    await expect(row(page, 'Refunds')).toHaveCount(0);
  });

  test('archiving every page leaves the empty state, and Undo brings them back', async ({
    page,
  }) => {
    await openPages(page);
    await selectAll(page);
    await archive(page).click();
    await expect(page.getByRole('heading', { name: 'No pages to show' })).toBeVisible();
    await toastRegion(page).getByRole('button', { name: 'Undo' }).click();
    await expect(pagesTable(page).getByRole('rowheader')).toHaveCount(9);
  });

  test('works at 390 px', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await openPages(page);
    await select(page, 'Refunds');
    await archive(page).click();
    const undo = toastRegion(page).getByRole('button', { name: 'Undo' });
    await expect(undo).toBeInViewport();
    await undo.click();
    await expect(row(page, 'Refunds')).toHaveCount(1);
  });

  test('a press on Archive with nothing chosen does nothing', async ({ page }) => {
    await openPages(page);
    await expect(archive(page)).toHaveAttribute('aria-disabled', 'true');
    // Playwright waits for an enabled button; a person's press is not held back.
    await archive(page).click({ force: true });
    await expect(toastRegion(page)).toHaveCount(0);
  });
});

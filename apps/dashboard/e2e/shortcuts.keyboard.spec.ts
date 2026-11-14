import { expect, type Page } from '@playwright/test';
import { SHORTCUTS } from '../src/shell/shortcuts.ts';
import { test } from './csp.ts';
import { banner, openShell, ROUTES, shortcutsSheet } from './fixtures.ts';

const account = (page: Page) => banner(page).getByRole('button', { name: /^MO/ });

async function fromMenu(page: Page): Promise<void> {
  await account(page).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: /Keyboard shortcuts/ }).click();
  await expect(shortcutsSheet(page)).toBeVisible();
}

test('Keyboard shortcuts in the account menu opens a sheet listing every registered shortcut', async ({
  page,
}) => {
  await openShell(page, ROUTES.overview);
  await fromMenu(page);
  const listed = await shortcutsSheet(page)
    .locator('[data-shortcut]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-shortcut')));
  expect([...listed].sort()).toEqual(SHORTCUTS.map((s) => s.id).sort());
  for (const s of SHORTCUTS) {
    await expect(shortcutsSheet(page).locator(`[data-shortcut="${s.id}"]`)).toContainText(s.does);
  }
  await page.keyboard.press('Escape');
  await expect(shortcutsSheet(page)).toHaveCount(0);
  await expect(account(page)).toBeFocused();
});

test('? opens it outside a field, and never from inside one', async ({ page }) => {
  await openShell(page, ROUTES.project);
  await page.keyboard.press('?');
  await expect(shortcutsSheet(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(shortcutsSheet(page)).toHaveCount(0);
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.setAttribute('aria-label', 'Stand in field');
    document.getElementById('main')?.prepend(input);
  });
  const field = page.getByRole('textbox', { name: 'Stand in field' });
  await field.focus();
  await page.keyboard.press('?');
  await expect(field).toHaveValue('?');
  await expect(shortcutsSheet(page)).toHaveCount(0);
});

test('turning single keys off stops G sequences and ?, and the choice outlasts a reload', async ({
  page,
}) => {
  await openShell(page, ROUTES.project);
  await fromMenu(page);
  const toggle = shortcutsSheet(page).getByRole('switch', { name: 'Single key shortcuts' });
  await expect(toggle).toBeChecked();
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(toggle).not.toBeChecked();
  await page.keyboard.press('Escape');
  await expect(shortcutsSheet(page)).toHaveCount(0);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-shell', 'ready');
  await page.keyboard.press('g');
  await page.keyboard.press('3');
  await page.keyboard.press('?');
  await expect(shortcutsSheet(page)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`${ROUTES.project}$`));
  // Turned back on, they work again.
  await fromMenu(page);
  const again = shortcutsSheet(page).getByRole('switch', { name: 'Single key shortcuts' });
  await again.focus();
  await page.keyboard.press('Space');
  await expect(again).toBeChecked();
  await page.keyboard.press('Escape');
  await page.keyboard.press('g');
  await page.keyboard.press('3');
  await expect(page).toHaveURL(/\/acme\/status(\/[a-z0-9-]+)?$/);
});

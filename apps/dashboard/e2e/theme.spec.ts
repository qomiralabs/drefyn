import { expect, test } from '@playwright/test';
import { ROUTES, useTheme } from './fixtures.ts';

const GROUND = { light: 'rgb(250, 250, 249)', dark: 'rgb(20, 18, 16)' } as const;

// Every script but the inline head script is blocked, so what is read is first paint, before
// hydration could fix anything.
for (const theme of ['light', 'dark'] as const) {
  test(`a stored ${theme} choice applies before hydration`, async ({ page }) => {
    await page.route('**/_next/static/**/*.js', (route) => route.abort());
    await useTheme(page, theme);
    // The system says the opposite, so only the stored choice can produce the result.
    await page.emulateMedia({ colorScheme: theme === 'dark' ? 'light' : 'dark' });
    await page.goto(ROUTES.overview);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('body')).toHaveCSS('background-color', GROUND[theme]);
  });

  test(`with no stored choice the system ${theme} applies`, async ({ page }) => {
    await page.route('**/_next/static/**/*.js', (route) => route.abort());
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(ROUTES.overview);
    await expect(page.locator('body')).toHaveCSS('background-color', GROUND[theme]);
  });
}

test('the account menu sets the theme and the choice survives a reload', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(ROUTES.overview);
  await expect(page.locator('html')).toHaveAttribute('data-shell', 'ready');
  await page.getByRole('button', { name: /account for Maya Okafor/ }).click();
  const menu = page.getByRole('menu', { name: 'Account' });
  await menu
    .getByRole('menuitem', { name: 'Dark' })
    .or(menu.getByRole('menuitemradio', { name: 'Dark' }))
    .click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('body')).toHaveCSS('background-color', GROUND.dark);
});

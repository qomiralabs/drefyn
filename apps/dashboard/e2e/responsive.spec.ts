import { expect, test } from '@playwright/test';
import { DESKTOP, MOBILE, openShell, products, ROUTES, TABLET } from './fixtures.ts';

test.describe('phone, 390 px', () => {
  test.use({ viewport: MOBILE });

  test('the sidebar and product links live in a drawer behind the menu button', async ({
    page,
  }) => {
    await openShell(page, ROUTES.project);
    await expect(page.getByRole('navigation', { name: 'Payments API docs' })).toBeHidden();
    await expect(products(page)).toBeHidden();
    const open = page.getByRole('button', { name: 'Open navigation' });
    await expect(open).toHaveAttribute('aria-expanded', 'false');
    await open.click();
    await expect(open).toHaveAttribute('aria-expanded', 'true');
    const drawer = page.getByRole('navigation', { name: 'Payments API docs' });
    await expect(drawer).toBeVisible();
    await expect(
      drawer.getByRole('navigation', { name: 'Products, in menu' }).getByRole('link'),
    ).toHaveText([/^Docs/, /^Studio/, /^Status/]);
    await expect(drawer.getByRole('link', { name: /^Pages/ })).toBeVisible();
    const box = await drawer.boundingBox();
    expect(box?.width).toBeLessThanOrEqual(18 * 16);
  });

  test('Escape closes the drawer and returns focus to the menu button', async ({ page }) => {
    await openShell(page, ROUTES.project);
    const open = page.getByRole('button', { name: 'Open navigation' });
    await open.click();
    await expect(page.getByRole('navigation', { name: 'Payments API docs' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('navigation', { name: 'Payments API docs' })).toBeHidden();
    await expect(open).toBeFocused();
  });

  test('the close button closes it too', async ({ page }) => {
    await openShell(page, ROUTES.project);
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.getByRole('button', { name: 'Close navigation' }).click();
    await expect(page.getByRole('navigation', { name: 'Payments API docs' })).toBeHidden();
  });

  test('nothing scrolls sideways', async ({ page }) => {
    for (const path of [ROUTES.overview, ROUTES.project, ROUTES.empty, ROUTES.error]) {
      await openShell(page, path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, path).toBe(0);
    }
  });
});

test.describe('tablet, 834 px', () => {
  test.use({ viewport: TABLET });

  test('the sidebar is a 48 px icon rail whose links keep their names', async ({ page }) => {
    await openShell(page, ROUTES.project);
    const rail = page.getByRole('navigation', { name: 'Payments API docs' });
    await expect(rail).toBeVisible();
    expect((await rail.boundingBox())?.width).toBe(48);
    for (const name of [
      'Home',
      'Pages',
      'Changes',
      'API reference',
      'Analytics',
      'Site settings',
    ]) {
      await expect(rail.getByRole('link', { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    await expect(rail.getByRole('link', { name: /^Home/ })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeHidden();
    await expect(products(page)).toBeVisible();
  });
});

test.describe('desktop, 1440 px', () => {
  test.use({ viewport: DESKTOP });

  test('the sidebar is 240 px and the menu button is gone', async ({ page }) => {
    await openShell(page, ROUTES.project);
    const side = page.getByRole('navigation', { name: 'Payments API docs' });
    expect((await side.boundingBox())?.width).toBe(240);
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeHidden();
  });

  test('the calm column is at most 45rem', async ({ page }) => {
    await openShell(page, ROUTES.overview);
    const h1 = page.getByRole('main').getByRole('heading', { level: 1 });
    expect((await h1.boundingBox())?.width).toBeLessThanOrEqual(45 * 16);
  });
});

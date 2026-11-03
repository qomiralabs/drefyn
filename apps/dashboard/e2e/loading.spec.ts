import { expect, type Page } from '@playwright/test';
import { test } from './csp.ts';
import { main, ROUTES } from './fixtures.ts';

// The loading fixture: the server sends the skeleton and ends its response, and only the
// browser waits. An open response would keep WebKit from running the page scripts at all.

const SKELETON = '[aria-hidden="true"][class~="bg-skeleton-fill"]';

// Main as the person sees it: React's boundary comments and templates are left out, since
// they say how the skeleton arrived, not what it is.
async function mainMarkup(page: Page): Promise<string> {
  const html = await main(page).innerHTML();
  return html.replace(/<!--[^]*?-->/g, '').replace(/<template[^>]*><\/template>/g, '');
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test('the server ends the response, and the body holds the skeleton', async ({ request }) => {
  const res = await request.get(ROUTES.loading, { timeout: 10_000 });
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body.trimEnd().endsWith('</html>')).toBe(true);
  expect(body).toContain('bg-skeleton-fill');
  expect(body).toContain('Pending docs');
});

test('the page loads, hydrates and stays busy on the skeleton', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto(ROUTES.loading);
  await expect(page.locator('html')).toHaveAttribute('data-shell', 'ready');
  await expect(main(page)).toHaveAttribute('aria-busy', 'true');
  await expect(main(page).getByRole('heading', { level: 1 })).toHaveText('Pending docs');
  await expect(main(page).locator(SKELETON).first()).toBeVisible();
  // The data never arrives, so nothing changes later either.
  await page.waitForTimeout(1_000);
  await expect(main(page)).toHaveAttribute('aria-busy', 'true');
  await expect(main(page).locator(SKELETON).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('the skeleton markup is unchanged', async ({ page }) => {
  await page.goto(ROUTES.loading, { waitUntil: 'commit' });
  await expect(main(page).locator(SKELETON).first()).toBeVisible();
  expect(await mainMarkup(page)).toMatchSnapshot('pending-skeleton.txt');
});

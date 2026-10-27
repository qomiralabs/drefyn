import { expect, test } from '@playwright/test';
import { ROUTES } from './fixtures.ts';

// This project runs against the server started with dashboard.shell off.
const paths = ['/', ...Object.values(ROUTES), '/acme/docs', '/acme/status', '/bundle-baseline'];

for (const path of paths) {
  test(`${path} is 404 with the release flag off`, async ({ request }) => {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.status()).toBe(404);
  });
}

test('the 404 page carries no shell, so nothing about the dashboard leaks', async ({ page }) => {
  await page.goto(ROUTES.overview);
  await expect(page.getByRole('banner')).toHaveCount(0);
  await expect(page.getByText('Acme')).toHaveCount(0);
  await expect(page.getByText('Maya Okafor')).toHaveCount(0);
});

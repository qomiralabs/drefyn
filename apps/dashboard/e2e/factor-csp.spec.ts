import { expect } from '@playwright/test';
import { test } from './csp.ts';
import { FACTOR_PAGES } from './fixtures.ts';

// The pages that show a secret or recovery codes are written by hand outside React. Each one
// draws its QR code as an SVG path under the strict policy, on every engine, and its body
// holds nothing but what the person reads.
for (const state of FACTOR_PAGES) {
  test(`the factor ${state} page renders with no CSP violation`, async ({ page }) => {
    const response = await page.goto(`/settings-states/factor/${state}`);
    expect(response?.status()).toBe(200);
    expect(response?.headers()['cache-control']).toBe('no-store');
    expect(response?.headers()['content-security-policy']).toContain('script-src');
    const body = (await response?.text()) ?? '';
    expect(body).not.toMatch(/<script|__next_f|\sstyle=|type="hidden"|otpauth:/i);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    if (state === 'enrol' || state === 'mistyped') {
      const qr = page.getByRole('img', { name: 'QR code for your authenticator app' });
      await expect(qr).toBeVisible();
      expect((await qr.boundingBox())?.width).toBeGreaterThan(150);
    } else {
      await expect(
        page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem'),
      ).toHaveCount(10);
    }
  });
}

test('the mistyped page puts focus on the code and names the error', async ({ page }) => {
  await page.goto('/settings-states/factor/mistyped');
  const field = page.getByLabel('6 digit code from the app');
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(field).toHaveAccessibleDescription(/did not match/);
});

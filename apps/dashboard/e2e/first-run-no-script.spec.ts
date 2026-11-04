import { expect } from '@playwright/test';
import { signInByCode, uniqueAddress } from './auth-helpers.ts';
import { OPEN_ORIGIN } from './fixtures.ts';
import { SIGNED_OUT } from './people.ts';
import { test } from './test.ts';

// Runs in the auth-no-js project, with scripts off, against the server with sign up open.
test.use({ baseURL: OPEN_ORIGIN, storageState: SIGNED_OUT });

test('the whole first run works with scripts off', async ({ page }) => {
  const address = uniqueAddress('noscript');
  await signInByCode(page, address);
  await expect(page).toHaveURL(/\/welcome/);
  await page.getByLabel('Your name').fill('evil.example');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByLabel('Your name')).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('Your name').fill('Maya Okafor');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/organizations\/new$/);
  const slug = (address.split('@')[0] ?? '').replace(/[^a-z0-9]/g, '').slice(-20);
  await page.getByLabel('Name', { exact: true }).fill('No Script');
  await page.getByLabel('Address').fill(slug);
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(new RegExp(`/${slug}$`));
});

test('Sign out works with scripts off', async ({ page }) => {
  await signInByCode(page, uniqueAddress('noscript'));
  await expect(page).toHaveURL(/\/welcome/);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in/);
});

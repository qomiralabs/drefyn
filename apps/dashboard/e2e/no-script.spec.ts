import { expect } from '@playwright/test';
import { uniqueAddress } from './auth-helpers.ts';
import { countTo, nextMail } from './mailpit.ts';
import { MAYA, SIGNED_OUT } from './people.ts';
import { test } from './test.ts';

// Runs in the auth-no-js project, with scripts off in the browser.
test.use({ storageState: SIGNED_OUT });

test('verify works by typing the code', async ({ page }) => {
  const seen = await countTo(MAYA.email);
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(MAYA.email);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page).toHaveURL(/\/sign-in\/verify/);
  await expect(page.getByRole('button', { name: /Continue as/ })).toHaveCount(0);
  const { code } = await nextMail(MAYA.email, seen);
  await page.getByLabel('8 digit code').fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/acme$/);
});

test('a wrong code says so, with scripts off', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(uniqueAddress('typed'));
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await page.getByLabel('8 digit code').fill('00000000');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('That code did not work.')).toBeVisible();
});

test('the CLI page takes the part after the hash in a field', async ({ page }) => {
  await page.goto('/sign-in/cli');
  await page.getByLabel('The part after #').fill('drf_cl_nothing');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'This sign in link no longer works.',
  );
});

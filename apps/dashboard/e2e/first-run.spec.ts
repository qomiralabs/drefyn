import { expect, type Page } from '@playwright/test';
import { signInByCode, uniqueAddress } from './auth-helpers.ts';
import { OPEN_ORIGIN } from './fixtures.ts';
import { SIGNED_OUT } from './people.ts';
import { test } from './test.ts';

// Runs against the server with sign up open, as a person with no account yet.
test.use({ baseURL: OPEN_ORIGIN, storageState: SIGNED_OUT });

const slugFor = (address: string): string =>
  (address.split('@')[0] ?? '').replace(/[^a-z0-9]/g, '').slice(-20);

async function signUp(page: Page): Promise<string> {
  const address = uniqueAddress('firstrun');
  await signInByCode(page, address);
  await expect(page).toHaveURL(/\/welcome/);
  return address;
}

async function nameYourself(page: Page) {
  await page.getByLabel('Your name').fill('Maya Okafor');
  await page.getByRole('button', { name: 'Continue' }).click();
}

test('a new person goes from the code through Welcome and an organization to the shell', async ({
  page,
}) => {
  const address = await signUp(page);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(address);
  await expect(page.getByRole('main').getByRole('list')).toHaveCount(0);
  await nameYourself(page);
  await expect(page).toHaveURL(/\/organizations\/new$/);
  await page.getByLabel('Name', { exact: true }).fill('First Run');
  const slug = slugFor(address);
  await page.getByLabel('Address').fill(slug);
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(new RegExp(`/${slug}$`));
  await expect(page.locator('html')).toHaveAttribute('data-shell', 'ready');
  await expect(page.getByRole('button', { name: /account for Maya Okafor/ })).toBeVisible();
});

test('a name and a password on Welcome both stick', async ({ page }) => {
  await signUp(page);
  await page.getByLabel('Password (optional)').fill('short');
  await nameYourself(page);
  await expect(page.getByText('Use at least 15 characters.')).toBeVisible();
  await expect(page.getByLabel('Your name')).toHaveValue('Maya Okafor');
  await page.getByLabel('Password (optional)').fill('a sentence that is long enough');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/organizations\/new$/);
});

test('nothing at / or the sign in pages can trap someone between pages', async ({ page }) => {
  await signUp(page);
  for (const path of ['/', '/sign-in', '/sign-up', '/organizations/new']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/welcome/);
  }
  await nameYourself(page);
  await expect(page).toHaveURL(/\/organizations\/new$/);
  await page.goto('/welcome');
  await expect(page).toHaveURL(/\/organizations\/new$/);
});

test('Sign out works from Welcome', async ({ page }) => {
  await signUp(page);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in/);
});

test('Sign out works from Create organization', async ({ page }) => {
  await signUp(page);
  await nameYourself(page);
  await expect(page).toHaveURL(/\/organizations\/new$/);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
});

test('an address someone holds says so and keeps what was typed', async ({ page }) => {
  await signUp(page);
  await nameYourself(page);
  await page.getByLabel('Name', { exact: true }).fill('Acme Two');
  await page.getByLabel('Address').fill('acme');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByText(/acme is taken/)).toBeVisible();
  await expect(page.getByLabel('Address')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Acme Two');
});

test('a slug the app needs for its own pages is refused', async ({ page }) => {
  await signUp(page);
  await nameYourself(page);
  await page.getByLabel('Name', { exact: true }).fill('Welcome Inc');
  await page.getByLabel('Address').fill('welcome');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByLabel('Address')).toHaveAttribute('aria-invalid', 'true');
});

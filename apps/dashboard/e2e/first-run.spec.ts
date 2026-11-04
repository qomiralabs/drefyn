import { expect, type Page } from '@playwright/test';
import { signInByCode, uniqueAddress } from './auth-helpers.ts';
import { OPEN_ORIGIN } from './fixtures.ts';
import { SIGNED_OUT } from './people.ts';
import { test } from './test.ts';

// Runs against the server with sign up open, as a person with no account yet.
test.use({ baseURL: OPEN_ORIGIN, storageState: SIGNED_OUT });

// A name of its own for each run, since a repeat would pick up a suffix.
const nameFor = (address: string): string =>
  `Team ${(address.split('@')[0] ?? '').replace(/[^a-z0-9]/g, '').slice(-20)}`;
const SUFFIX = '-[a-z0-9]{4}';

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
  const name = nameFor(address);
  await expect(page.locator('main input:not([type=hidden])')).toHaveCount(1);
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(new RegExp(`/${name.toLowerCase().replace(' ', '-')}$`));
  await expect(page.locator('html')).toHaveAttribute('data-shell', 'ready');
  await expect(page.getByRole('button', { name: /account for Maya Okafor/ })).toBeVisible();
});

test('a name and a password on Welcome both stick', async ({ page }) => {
  await signUp(page);
  await page.getByLabel('Password (optional)', { exact: true }).fill('short');
  await nameYourself(page);
  await expect(page.getByText('Use at least 15 characters.')).toBeVisible();
  await expect(page.getByLabel('Your name')).toHaveValue('Maya Okafor');
  await page
    .getByLabel('Password (optional)', { exact: true })
    .fill('a sentence that is long enough');
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

test('a name someone holds still makes an organization and opens it', async ({ page }) => {
  await signUp(page);
  await nameYourself(page);
  await page.getByLabel('Name', { exact: true }).fill('Acme');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(new RegExp(`/acme${SUFFIX}$`));
  await expect(page.locator('html')).toHaveAttribute('data-shell', 'ready');
});

test('a name matching one of the app pages still makes an organization', async ({ page }) => {
  await signUp(page);
  await nameYourself(page);
  await page.getByLabel('Name', { exact: true }).fill('Welcome');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(new RegExp(`/welcome${SUFFIX}$`));
  await expect(page.locator('html')).toHaveAttribute('data-shell', 'ready');
});

test('a name with no Latin letters still makes an organization', async ({ page }) => {
  await signUp(page);
  await nameYourself(page);
  await page.getByLabel('Name', { exact: true }).fill('北京');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(new RegExp(`/org${SUFFIX}$`));
});

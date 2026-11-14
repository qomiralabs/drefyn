import { expect, type Browser, type Page } from '@playwright/test';
import { seedPerson, signInByCode, uniqueAddress } from './auth-helpers.ts';
import { OPEN_ORIGIN } from './fixtures.ts';
import {
  expectMarkOn,
  forgetSession,
  LAST_METHOD,
  lastMethodValue,
  marked,
} from './last-method.ts';
import { SIGNED_OUT } from './people.ts';
import { test } from './test.ts';

// Sign up is open here, so a new address signs in by code without an invitation.
test.use({ baseURL: OPEN_ORIGIN, storageState: SIGNED_OUT });

const PASSWORD = 'a long and private passphrase';

async function byPassword(page: Page, address: string): Promise<void> {
  await page.goto('/sign-in/password');
  await page.getByLabel('Email address').fill(address);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
}

test('after an email code the code button says Last used, on sign in and sign up', async ({
  page,
}) => {
  await signInByCode(page, uniqueAddress('last-code'));
  await expect(page).toHaveURL(/\/welcome/);
  expect(await lastMethodValue(page)).toBe('email_code');
  await forgetSession(page);
  for (const path of ['/sign-in', '/sign-up']) {
    await page.goto(path);
    await expectMarkOn(page.getByRole('button', { name: /^Email me a code/ }));
  }
});

test('after a password the password link says Last used', async ({ page }) => {
  const address = uniqueAddress('last-password');
  await seedPerson(address, PASSWORD);
  await byPassword(page, address);
  expect(await lastMethodValue(page)).toBe('password');
  await forgetSession(page);
  await page.goto('/sign-in');
  await expectMarkOn(page.getByRole('link', { name: /^Use a password instead/ }));
});

test('a wrong code and a wrong password write nothing', async ({ page }) => {
  const address = uniqueAddress('last-wrong');
  await seedPerson(address, PASSWORD);
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(address);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await page.getByLabel('8 digit code').fill('00000000');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('That code did not work.')).toBeVisible();
  expect(await lastMethodValue(page)).toBeUndefined();
  await page.goto('/sign-in/password');
  await page.getByLabel('Email address').fill(address);
  await page.getByLabel('Password', { exact: true }).fill('not the passphrase at all');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('That address and password do not match.')).toBeVisible();
  expect(await lastMethodValue(page)).toBeUndefined();
});

for (const [name, value] of [
  ['a forged value', 'GitHub'],
  ['an unknown value', 'sso_admin'],
  ['a padded value', '%20github'],
] as const) {
  test(`${name} shows no mark anywhere`, async ({ page }) => {
    await page
      .context()
      .addCookies([{ name: LAST_METHOD, value, url: OPEN_ORIGIN, httpOnly: true }]);
    for (const path of ['/sign-in', '/sign-up']) {
      await page.goto(path);
      await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible();
      await expect(marked(page)).toHaveCount(0);
    }
  });
}

test('a cleared cookie shows no mark', async ({ page }) => {
  await signInByCode(page, uniqueAddress('last-cleared'));
  await expect(page).toHaveURL(/\/welcome/);
  await page.context().clearCookies();
  await page.goto('/sign-in');
  await expect(marked(page)).toHaveCount(0);
});

// What a stranger at the same browser sees: only which way, never who.
async function signInPageAfter(browser: Browser, address: string, known: boolean) {
  const context = await browser.newContext({ baseURL: OPEN_ORIGIN, storageState: SIGNED_OUT });
  const page = await context.newPage();
  if (known) await seedPerson(address);
  await signInByCode(page, address);
  await expect(page).not.toHaveURL(/\/sign-in/);
  await forgetSession(page);
  await page.goto('/sign-in');
  const html = await page.getByRole('main').innerHTML();
  await context.close();
  return html.replace(/name="csrf" value="[^"]*"/g, 'name="csrf" value=""');
}

test('the page is the same whichever account signed in, known or new', async ({ browser }) => {
  const known = await signInPageAfter(browser, uniqueAddress('last-known'), true);
  const unknown = await signInPageAfter(browser, uniqueAddress('last-unknown'), false);
  expect(known).toContain('Last used');
  expect(unknown).toBe(known);
});

import { expect, type Page } from '@playwright/test';
import { askForCode, signInByCode, uniqueAddress } from './auth-helpers.ts';
import { OPEN_ORIGIN } from './fixtures.ts';
import { newDeviceNotices } from './mailpit.ts';
import { SIGNED_OUT } from './people.ts';
import { test } from './test.ts';

// Runs in all three shell engines, as people of its own: signing out ends a session, and
// the seeded ones are shared.
test.use({ baseURL: OPEN_ORIGIN, storageState: SIGNED_OUT });

// Mail leaves after the response, so a mail that should not exist is given time to appear.
const MAIL_SETTLE_MS = 1_000;

const cookieNames = async (page: Page) =>
  (await page.context().cookies()).map((cookie) => cookie.name);

async function signUp(page: Page): Promise<string> {
  const address = uniqueAddress('signout');
  await signInByCode(page, address);
  await expect(page).toHaveURL(/\/welcome/);
  expect(await cookieNames(page)).toEqual(
    expect.arrayContaining(['drefyn_session', 'drefyn_device']),
  );
  return address;
}

async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
}

// Through the API context, because WebKit hides this redirect's headers from Playwright.
test('Sign out sends no Clear-Site-Data, stays uncached and goes to sign in', async ({ page }) => {
  await signUp(page);
  const response = await page.context().request.post('/sign-out', {
    headers: { origin: OPEN_ORIGIN },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(303);
  expect(response.headers()['clear-site-data']).toBeUndefined();
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(response.headers()['location']).toBe(`${OPEN_ORIGIN}/sign-in`);
  const expired = response
    .headersArray()
    .filter(({ name }) => name.toLowerCase() === 'set-cookie')
    .map(({ value }) => value.split('=')[0]);
  expect(expired.sort()).toEqual(['drefyn_invite', 'drefyn_oauth', 'drefyn_pre', 'drefyn_session']);
});

test('Sign out ends the session, keeps the device and leaves sign in working', async ({ page }) => {
  const address = await signUp(page);
  await signOut(page);

  const names = await cookieNames(page);
  expect(names).not.toContain('drefyn_session');
  expect(names).toContain('drefyn_device');

  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in/);
  await askForCode(page, address);
});

test('Sign out drops its own cookies and leaves every other cookie alone', async ({ page }) => {
  await signUp(page);
  const plant = (name: string) => ({ name, value: 'x', url: OPEN_ORIGIN });
  await page.context().addCookies([plant('drefyn_invite'), plant('drefyn_oauth'), plant('sso')]);
  await signOut(page);

  const names = await cookieNames(page);
  if (names.includes('drefyn_invite') || names.includes('drefyn_oauth')) {
    const started = Date.now();
    for (const wait of [0, 100, 400, 1500, 3000]) {
      await page.waitForTimeout(wait);
      const held = await page.context().cookies();
      console.log(
        `LATE +${String(Date.now() - started)} ${JSON.stringify(held.map(({ name, value, expires, httpOnly, sameSite, path }) => ({ name, value: value.slice(0, 6), expires, httpOnly, sameSite, path })))}`,
      );
    }
    await page.goto('/sign-in');
    const sent = await page.evaluate(() => document.cookie);
    console.log(`LATE document ${sent}`);
  }
  expect(names).not.toContain('drefyn_invite');
  expect(names).not.toContain('drefyn_oauth');
  expect(names).toContain('sso');
});

test('Signing back in after Sign out mails no new device notice', async ({ page, browser }) => {
  const address = await signUp(page);
  await page.waitForTimeout(MAIL_SETTLE_MS);
  const before = await newDeviceNotices(address);
  await signOut(page);

  await signInByCode(page, address);
  await expect(page).toHaveURL(/\/welcome/);
  await page.waitForTimeout(MAIL_SETTLE_MS);
  expect(await newDeviceNotices(address)).toBe(before);

  // Not vacuous: a browser this person never used does get one.
  const other = await browser.newContext();
  await signInByCode(await other.newPage(), address);
  await expect.poll(() => newDeviceNotices(address)).toBe(before + 1);
  await other.close();
});

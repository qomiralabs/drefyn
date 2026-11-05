import { expect, type Page } from '@playwright/test';
import { askForCode, signInByCode, uniqueAddress } from './auth-helpers.ts';
import { OPEN_ORIGIN } from './fixtures.ts';
import { SIGNED_OUT } from './people.ts';
import { test } from './test.ts';

// Runs in all three shell engines, as people of its own: signing out ends a session, and
// the seeded ones are shared.
test.use({ baseURL: OPEN_ORIGIN, storageState: SIGNED_OUT });

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

// Through the API context, because WebKit hides this redirect's headers from Playwright.
test('Sign out answers with Clear-Site-Data, uncached, and goes to sign in', async ({ page }) => {
  await signUp(page);
  const response = await page.context().request.post('/sign-out', {
    headers: { origin: OPEN_ORIGIN },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(303);
  expect(response.headers()['clear-site-data']).toBe('"cookies"');
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(response.headers()['location']).toBe(`${OPEN_ORIGIN}/sign-in`);
});

test('Sign out ends the session, clears the browser and leaves sign in working', async ({
  page,
  browserName,
}) => {
  const address = await signUp(page);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);

  expect(await cookieNames(page)).not.toContain('drefyn_session');
  // Playwright's WebKit build ignores the header, and the session cookie above goes by its
  // own Set-Cookie for that reason. The other two must drop what the server did not name.
  if (browserName !== 'webkit') expect(await cookieNames(page)).not.toContain('drefyn_device');

  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in/);
  await askForCode(page, address);
});

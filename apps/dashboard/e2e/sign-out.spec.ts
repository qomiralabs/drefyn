import { expect } from '@playwright/test';
import { askForCode, signInByCode, uniqueAddress } from './auth-helpers.ts';
import { OPEN_ORIGIN } from './fixtures.ts';
import { SIGNED_OUT } from './people.ts';
import { test } from './test.ts';

// Runs in all three shell engines, as a person of its own: signing out ends a session, and
// the seeded ones are shared.
test.use({ baseURL: OPEN_ORIGIN, storageState: SIGNED_OUT });

test('Sign out ends the session, clears the browser and leaves sign in working', async ({
  page,
  context,
  browserName,
}) => {
  const address = uniqueAddress('signout');
  await signInByCode(page, address);
  await expect(page).toHaveURL(/\/welcome/);
  const names = async () => (await context.cookies()).map((cookie) => cookie.name);
  expect(await names()).toEqual(expect.arrayContaining(['drefyn_session', 'drefyn_device']));

  const answered = page.waitForResponse((response) => response.url().endsWith('/sign-out'));
  await page.getByRole('button', { name: 'Sign out' }).click();
  const response = await answered;
  expect(response.status()).toBe(303);
  expect(await response.headerValue('clear-site-data')).toBe('"cookies"');
  expect(await response.headerValue('cache-control')).toBe('no-store');
  await expect(page).toHaveURL(/\/sign-in$/);

  expect(await names()).not.toContain('drefyn_session');
  // Playwright's WebKit build ignores the header, and the session cookie above goes by its
  // own Set-Cookie for that reason. The other two must drop what the server did not name.
  if (browserName !== 'webkit') expect(await names()).not.toContain('drefyn_device');

  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in/);
  await askForCode(page, address);
});

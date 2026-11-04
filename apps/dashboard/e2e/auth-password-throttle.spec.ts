import { randomBytes } from 'node:crypto';
import { expect, type Browser } from '@playwright/test';
import { seedPerson, uniqueAddress } from './auth-helpers.ts';
import { countTo, nextMail } from './mailpit.ts';
import { SIGNED_OUT } from './people.ts';
import { test } from './test.ts';

// Runs in the auth-hop project, for the same reason as the lockout spec.
test.use({ storageState: SIGNED_OUT });

const PASSWORD = 'paper lantern over the harbour';
// The default password_fail limit for one address.
const BUCKET = 10;

const client = (browser: Browser, ip: string) =>
  browser.newContext({ storageState: SIGNED_OUT, extraHTTPHeaders: { 'x-test-client': ip } });

test('a filled password bucket refuses the right password and leaves the email code', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const victim = uniqueAddress('throttled');
  await seedPerson(victim, PASSWORD);
  let tries = 0;
  for (const ip of ['2001:db8:21::1', '2001:db8:22::1']) {
    const attacker = await client(browser, ip);
    const tab = await attacker.newPage();
    while (tries < Math.ceil(((BUCKET + 1) * (ip.endsWith('21::1') ? 1 : 2)) / 2)) {
      await tab.goto('/sign-in/password');
      await tab.getByLabel('Email address').fill(victim);
      await tab.getByLabel('Password', { exact: true }).fill(randomBytes(12).toString('hex'));
      await tab.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(tab.getByRole('alert').or(tab.getByRole('status')).first()).toBeVisible();
      tries += 1;
    }
    await attacker.close();
  }

  const own = await client(browser, '2001:db8:a::2');
  const page = await own.newPage();
  await page.goto('/sign-in/password');
  await page.getByLabel('Email address').fill(victim);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Too many password tries for this address.')).toBeVisible();
  expect((await own.cookies()).some((c) => c.name.endsWith('session'))).toBe(false);

  const seen = await countTo(victim);
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(victim);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page).toHaveURL(/\/sign-in\/verify/);
  const { code } = await nextMail(victim, seen);
  await page.getByLabel('8 digit code').fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect
    .poll(async () => (await own.cookies()).some((c) => c.name.endsWith('session')))
    .toBe(true);
  await own.close();
});

import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { authSql, seedPerson, uniqueAddress } from './auth-helpers.ts';
import { behindHop } from './hop.ts';
import { countTo, nextMail } from './mailpit.ts';
import { SIGNED_OUT } from './people.ts';
import { test } from './test.ts';

// Runs in the auth-hop project: every request crosses the trusted hop, so each client below
// is a real resolved address to the server, and the buckets are the production ones.
test.use({ storageState: SIGNED_OUT });

const VICTIM_IP = '2001:db8:a::1';
// The shared ceiling the auth-hop server runs with.
const CEILING = 8;
// Mail leaves after the response, so a mail that should not exist is given time to appear.
const MAIL_SETTLE_MS = 1_000;

const CEILING_ROWS = `select count(*) from app.auth_rate_limits where bucket = 'email_send_address_ceiling'`;
const hasSession = async (context: BrowserContext) =>
  (await context.cookies()).some((c) => c.name.endsWith('session'));

async function client(browser: Browser, ip: string): Promise<BrowserContext> {
  const context = await browser.newContext({ storageState: SIGNED_OUT });
  await behindHop(context, ip);
  return context;
}

async function ask(page: Page, address: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(address);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await page.waitForLoadState('networkidle');
}

async function signIn(page: Page, address: string): Promise<void> {
  const seen = await countTo(address);
  await ask(page, address);
  await expect(page).toHaveURL(/\/sign-in\/verify/);
  const { code } = await nextMail(address, seen);
  await page.getByLabel('8 digit code').fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect.poll(() => hasSession(page.context())).toBe(true);
  // The cookie lands before the redirect does, and a navigation now would race it.
  await expect(page).toHaveURL(/\/welcome/);
}

// The real button, because what the response does to the browser's cookies is the point.
async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  // Sign out drops the pre sign in cookie, and the hop draws each redirect as a page of its
  // own, so that URL first belongs to an empty refresh bound for the mint route. Only the
  // form proves the hops are over, and a navigation before it can lose to the last refresh.
  await expect(page.getByLabel('Email address')).toBeVisible();
  await expect.poll(() => hasSession(page.context())).toBe(false);
}

const prefixes = (n: number) =>
  Array.from({ length: n }, (_, i) => `2001:db8:${(i + 16).toString(16)}::1`);

// Spends the shared ceiling from the given prefixes, past it whatever their number.
async function spendCeiling(
  browser: Browser,
  address: string,
  count: number,
): Promise<readonly BrowserContext[]> {
  const attackers = await Promise.all(prefixes(count).map((ip) => client(browser, ip)));
  let sends = 0;
  while (sends < CEILING + 2) {
    for (const attacker of attackers) {
      const tab = await attacker.newPage();
      await ask(tab, address);
      await tab.close();
      sends += 1;
    }
  }
  return attackers;
}

// Not vacuous: a stranger on a fresh prefix now gets nothing for this address.
async function expectStrangerRefused(browser: Browser, address: string): Promise<BrowserContext> {
  const stranger = await client(browser, '2001:db8:ffff::1');
  const seen = await countTo(address);
  const page = await stranger.newPage();
  await ask(page, address);
  await expect.poll(async () => authSql(CEILING_ROWS)).not.toBe('0');
  await page.waitForTimeout(MAIL_SETTLE_MS);
  expect(await countTo(address)).toBe(seen);
  return stranger;
}

for (const count of [4, 16]) {
  test(`${String(count)} prefixes and a second browser do not stop the victim`, async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const victim = uniqueAddress('victim');
    await seedPerson(victim);
    // The victim signed in before, so this browser is a device the server knows.
    const own = await client(browser, VICTIM_IP);
    const page = await own.newPage();
    await signIn(page, victim);
    await signOut(page);

    // A challenge from before the attack, which the attack must not cost the victim.
    const before = await countTo(victim);
    await ask(page, victim);
    await expect(page).toHaveURL(/\/sign-in\/verify/);
    const held = await nextMail(victim, before);
    const attemptsOfNewest = () =>
      authSql(`select attempts from app.email_challenges
           where email_normalized = '${victim}' and consumed_at is null
           order by created_at limit 1`);

    const attackers = await spendCeiling(browser, victim, count);

    // Browser B opens the victim's link: no binding, so no attempt is spent.
    const attempts = await attemptsOfNewest();
    const second = await client(browser, '2001:db8:fffe::1');
    const secondPage = await second.newPage();
    const link = new URL(held.link);
    // The refresh a redirect becomes here drops a fragment, so B gets its cookie first.
    await secondPage.goto('/sign-in');
    await expect(secondPage.getByLabel('Email address')).toBeVisible();
    await secondPage.goto(link.pathname + link.hash);
    await expect(secondPage.getByRole('heading', { level: 1 })).toContainText(
      'Type this code where you asked.',
    );
    expect(await attemptsOfNewest()).toBe(attempts);

    const stranger = await expectStrangerRefused(browser, victim);

    // The challenge from before the attack still works, then a fresh sign in does.
    await page.getByLabel('8 digit code').fill(held.code);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect.poll(() => hasSession(own)).toBe(true);
    await expect(page).toHaveURL(/\/welcome/);
    await signOut(page);
    await signIn(page, victim);
    await Promise.all([...attackers, second, stranger, own].map((c) => c.close()));
  });
}

// Signing out must not turn the person's own browser into a stranger: a code only account
// would have no way back in for the rest of the day.
test('Signing out and back in keeps working while the ceiling is spent', async ({ browser }) => {
  test.setTimeout(180_000);
  const victim = uniqueAddress('returning');
  await seedPerson(victim);
  const own = await client(browser, VICTIM_IP);
  const page = await own.newPage();
  await signIn(page, victim);
  await signOut(page);

  const attackers = await spendCeiling(browser, victim, 4);
  const stranger = await expectStrangerRefused(browser, victim);

  // Twice, which with the first sign in is all the per address limit allows in ten minutes.
  for (const round of [1, 2]) {
    await test.step(`sign in ${String(round)} after the attack`, async () => {
      await signIn(page, victim);
      await signOut(page);
    });
  }
  await Promise.all([...attackers, stranger, own].map((c) => c.close()));
});

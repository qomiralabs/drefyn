import { randomBytes } from 'node:crypto';
import { expect, type Browser, type BrowserContext } from '@playwright/test';
import { authSql, seedPerson, uniqueAddress } from './auth-helpers.ts';
import { behindHop } from './hop.ts';
import { countTo, nextMail } from './mailpit.ts';
import { SIGNED_OUT } from './people.ts';
import { test } from './test.ts';

// Runs in the auth-hop project, for the same reason as the lockout spec.
test.use({ storageState: SIGNED_OUT });

const PASSWORD = 'paper lantern over the harbour';
// The default password_fail limit for one address.
const BUCKET = 10;
// Longer than the next step takes, so a try that moves on before its answer loses the race.
const SLOW_ANSWER_MS = 250;
// The password_fail window. The limiter counts in fixed windows that start on multiples of
// their length by the database clock, so tries either side of an edge land in two counts.
const WINDOW_SECONDS = 15 * 60;
// More than the tries and the right password take on a slow runner, about 15 s in CI.
const ROOM_SECONDS = 45;
const WRONG = 'That address and password do not match.';
const LIMITED = 'Too many password tries for this address.';

async function client(browser: Browser, ip: string) {
  const context = await browser.newContext({ storageState: SIGNED_OUT });
  await behindHop(context, ip);
  return context;
}

// Holds each password post before the hop sends it on, as a slow network would. A try that
// navigates away first cancels its post, and the server never counts it.
async function slowAnswers(context: BrowserContext) {
  await context.route('**/sign-in/password', async (route) => {
    if (route.request().method() === 'POST') {
      await new Promise((resolve) => setTimeout(resolve, SLOW_ANSWER_MS));
    }
    await route.fallback().catch(() => undefined);
  });
}

// Seconds until the current window ends, by the clock the limiter reads.
async function windowLeft(): Promise<number> {
  const w = String(WINDOW_SECONDS);
  return Number(await authSql(`select ${w} - floor(extract(epoch from now()))::bigint % ${w}`));
}

test('a filled password bucket refuses the right password and leaves the email code', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const victim = uniqueAddress('throttled');
  await seedPerson(victim, PASSWORD);
  // A /64 of this run's own for each client, so the per address limit is the only one that
  // fills, however often the spec ran on this stack in the last ten minutes.
  const run = randomBytes(2).toString('hex');
  const attackers = [`2001:db8:21:${run}::1`, `2001:db8:22:${run}::1`];
  // A run that crossed an edge let the eleventh try and the right password through, so the
  // tries start in a window with room for all of them.
  await expect
    .poll(windowLeft, { timeout: (ROOM_SECONDS + 5) * 1000, intervals: [1000] })
    .toBeGreaterThan(ROOM_SECONDS);
  const left = await windowLeft();
  let tries = 0;
  for (const ip of attackers) {
    const attacker = await client(browser, ip);
    await slowAnswers(attacker);
    const tab = await attacker.newPage();
    while (tries < Math.ceil(((BUCKET + 1) * (ip === attackers[0] ? 1 : 2)) / 2)) {
      await tab.goto('/sign-in/password');
      await tab.getByLabel('Email address').fill(victim);
      await tab.getByLabel('Password', { exact: true }).fill(randomBytes(12).toString('hex'));
      await tab.getByRole('button', { name: 'Sign in', exact: true }).click();
      // The answer to this try, by its words: Next's route announcer is an empty alert on
      // every page, so any alert at all is there before the post lands. Each try is counted
      // before the hash runs, so the last one meets the full bucket.
      await expect(tab.getByText(tries < BUCKET ? WRONG : LIMITED)).toBeVisible();
      tries += 1;
    }
    await attacker.close();
  }

  const own = await client(browser, `2001:db8:a:${run}::2`);
  const page = await own.newPage();
  await page.goto('/sign-in/password');
  await page.getByLabel('Email address').fill(victim);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText(LIMITED)).toBeVisible();
  expect((await own.cookies()).some((c) => c.name.endsWith('session'))).toBe(false);
  // Still the window the tries filled, or the refusal above proved nothing about one bucket.
  expect(await windowLeft()).toBeLessThan(left);

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

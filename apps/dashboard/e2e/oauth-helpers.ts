import { randomInt } from 'node:crypto';
import { expect, request, type BrowserContext, type Page, type Route } from '@playwright/test';
import { authSql, userSql } from './auth-helpers.ts';
import { test as base } from './test.ts';
import {
  BROWSER_HOSTS,
  encodeScript,
  FAKE_ORIGIN,
  fakeUrl,
  isAuthorizationUrl,
  type FakeAccount,
  type FakeScript,
  type ProviderName,
} from './oauth-fake.ts';

const START = /^http:\/\/127\.0\.0\.1:\d+\/auth\/oauth\/(?:github|google)\/start(?:\?|$)/;
const OFF_THE_MACHINE = (url: URL) => url.hostname !== '127.0.0.1';

const escaped = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');

function withoutRedirect(headers: Readonly<Record<string, string>>): Record<string, string> {
  const kept = Object.entries(headers).filter(
    ([name]) => !['content-length', 'transfer-encoding', 'location'].includes(name),
  );
  return { ...Object.fromEntries(kept), 'content-type': 'text/html' };
}

export class ProviderRoute {
  // The next visit to a provider. Set it before the browser gets there.
  script: FakeScript | null = null;
  // When true, the browser stops short of the callback, and the test has the URL.
  holdCallback = false;
  readonly handovers: URL[] = [];
  readonly callbacks: string[] = [];
  readonly strays: string[] = [];

  // The real redirect would leave Playwright's sight, so it becomes a page that moves on by
  // itself. A refresh is a new navigation and comes back through route(). Cookies stay on it.
  private async handOver(route: Route): Promise<void> {
    const response = await route.fetch({ maxRedirects: 0 });
    const location = response.headers()['location'] ?? '/';
    const target = new URL(location, route.request().url());
    if (isAuthorizationUrl(target)) this.handovers.push(target);
    await route.fulfill({
      response,
      status: 200,
      headers: withoutRedirect(response.headers()),
      body: `<meta http-equiv="refresh" content="0;url=${escaped(location)}">`,
    });
  }

  private async toFake(route: Route): Promise<void> {
    const url = new URL(route.request().url());
    if (!BROWSER_HOSTS.some((host) => host === url.host)) {
      this.strays.push(url.href);
      await route.abort();
      return;
    }
    if (isAuthorizationUrl(url) && this.script !== null) {
      url.searchParams.set('fake_script', encodeScript(this.script));
    }
    const response = await route.fetch({ url: fakeUrl(url), maxRedirects: 0 });
    const location = response.headers()['location'];
    if (location === undefined) {
      await route.fulfill({ response });
      return;
    }
    this.callbacks.push(location);
    if (this.holdCallback) {
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Held</h1>' });
      return;
    }
    await route.fulfill({ response });
  }

  async attach(context: BrowserContext): Promise<void> {
    await context.route(START, (route) => this.handOver(route));
    await context.route(OFF_THE_MACHINE, (route) => this.toFake(route));
  }
}

export const test = base.extend<{ provider: ProviderRoute }>({
  provider: [
    async ({ context }, use) => {
      const provider = new ProviderRoute();
      await provider.attach(context);
      await use(provider);
      expect(provider.strays).toEqual([]);
    },
    { auto: true },
  ],
});

export interface ProviderCase {
  readonly name: ProviderName;
  readonly label: 'GitHub' | 'Google';
  // Spending a code twice: GitHub's answer means start again, Google's is a plain error.
  readonly replayError: 'state' | 'provider';
}

export const GITHUB: ProviderCase = { name: 'github', label: 'GitHub', replayError: 'state' };
const GOOGLE: ProviderCase = { name: 'google', label: 'Google', replayError: 'provider' };
export const PROVIDERS: readonly ProviderCase[] = [GITHUB, GOOGLE];

// A subject of its own per test: a known subject signs in whoever already holds it.
export const newAccount = (email: string, rest: Partial<FakeAccount> = {}): FakeAccount => ({
  subject: String(randomInt(40_000_000, 280_000_000_000)),
  email,
  verified: true,
  ...rest,
});

export async function toProvider(page: Page, label: string, next?: string): Promise<void> {
  const query = next === undefined ? '' : `?next=${encodeURIComponent(next)}`;
  await page.goto(`/sign-in${query}`);
  await page.getByRole('link', { name: `Continue with ${label}` }).click();
  await expect(page.getByRole('heading', { name: `Fake ${label}` })).toBeVisible();
}

export async function signInThrough(
  page: Page,
  provider: ProviderRoute,
  { label }: ProviderCase,
  script: FakeScript,
): Promise<void> {
  provider.script = script;
  await toProvider(page, label);
  await page.getByRole('link', { name: 'Authorize' }).click();
}

const count = (statement: string) => authSql(`select count(*) from ${statement}`);

export const usersOf = (address: string): Promise<string> =>
  count(`app.users where email_normalized = '${address}'`);

export const identitiesOf = (provider: ProviderName, account: FakeAccount): Promise<string> =>
  count(
    `app.identities where provider = '${provider}' and provider_subject = '${account.subject}'`,
  );

// Through the person's own context: the pre sign in role has no grant on sessions.
export async function sessionsOf(address: string): Promise<string> {
  const id = await authSql(`select id from app.users where email_normalized = '${address}'`);
  if (id === '') return '0';
  return userSql(id, `select count(*) from app.sessions where user_id = '${id}'`);
}

export const hasSession = async (page: Page): Promise<boolean> =>
  (await page.context().cookies()).some((cookie) => cookie.name === 'drefyn_session');

// A safe page and no way in: the browser holds nothing, and the guard agrees.
export async function expectNoSession(page: Page, address: string): Promise<void> {
  expect(await hasSession(page)).toBe(false);
  expect(await sessionsOf(address)).toBe('0');
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in/);
}

export async function fakeLog(): Promise<readonly string[]> {
  const context = await request.newContext();
  try {
    return (await (await context.get(`${FAKE_ORIGIN}/__log`)).json()) as string[];
  } finally {
    await context.dispose();
  }
}

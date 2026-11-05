import { expect, type Page } from '@playwright/test';
import { seedPerson, uniqueAddress } from './auth-helpers.ts';
import { countTo, nextMail } from './mailpit.ts';
import { FAKE_CLIENTS, OAUTH_ORIGIN } from './oauth-fake.ts';
import {
  expectNoSession,
  fakeLog,
  GITHUB,
  hasSession,
  identitiesOf,
  newAccount,
  PROVIDERS,
  sessionsOf,
  signInThrough,
  test,
  toProvider,
  usersOf,
} from './oauth-helpers.ts';
import { SIGNED_OUT } from './people.ts';

// A real build through the whole redirect, in a browser, with sign up open. The provider is
// the fake in the e2e stack; nothing here can reach a real one.
test.use({ baseURL: OAUTH_ORIGIN, storageState: SIGNED_OUT });

const failed = (page: Page, label: string) =>
  page.getByText(`${label} did not finish signing you in.`);
const unconfirmed = (page: Page, label: string) =>
  page.getByText(`${label} has no confirmed email address for you.`);

async function nameYourself(page: Page) {
  await page.getByLabel('Your name').fill('Maya Okafor');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/organizations\/new$/);
}

for (const each of PROVIDERS) {
  const { name, label, replayError } = each;

  test.describe(`${label} sign in`, () => {
    test('a new person goes through the redirect and lands on Welcome', async ({
      page,
      provider,
    }) => {
      const address = uniqueAddress(`oauth-new-${name}`);
      const account = newAccount(address);
      await signInThrough(page, provider, each, { account });
      await expect(page).toHaveURL(/\/welcome$/);
      await expect(page.getByRole('heading', { level: 1 })).toContainText(address);
      expect(await hasSession(page)).toBe(true);
      expect(await usersOf(address)).toBe('1');
      expect(await identitiesOf(name, account)).toBe('1');
      expect(await sessionsOf(address)).toBe('1');
    });

    test('the start asks with PKCE and the fixed callback, and shows no secret', async ({
      page,
      provider,
    }) => {
      provider.script = { account: newAccount(uniqueAddress(`oauth-ask-${name}`)) };
      await toProvider(page, label);
      const asked = provider.handovers[0]?.searchParams;
      expect(asked?.get('client_id')).toBe(FAKE_CLIENTS[name].id);
      expect(asked?.get('redirect_uri')).toBe(`${OAUTH_ORIGIN}/auth/oauth/${name}/callback`);
      expect(asked?.get('code_challenge_method')).toBe('S256');
      expect(asked?.get('code_challenge')).toMatch(/^[\w-]{43}$/);
      expect(asked?.get('nonce') !== null).toBe(name === 'google');
      expect(asked?.has('client_secret')).toBe(false);
      const cookies = await page.context().cookies();
      expect(cookies.find((cookie) => cookie.name === 'drefyn_oauth')?.value).toBe(
        asked?.get('state'),
      );
    });

    test('an existing account signs in again without Welcome or a second row', async ({
      page,
      provider,
    }) => {
      const address = uniqueAddress(`oauth-back-${name}`);
      const account = newAccount(address);
      await signInThrough(page, provider, each, { account });
      await expect(page).toHaveURL(/\/welcome$/);
      await nameYourself(page);
      await page.getByRole('button', { name: 'Sign out' }).click();
      await expect(page).toHaveURL(/\/sign-in$/);
      await signInThrough(page, provider, each, { account });
      await expect(page).toHaveURL(/\/organizations\/new$/);
      expect(await usersOf(address)).toBe('1');
      expect(await identitiesOf(name, account)).toBe('1');
      expect(await sessionsOf(address)).toBe('1');
    });

    test('a return path survives the trip, and an outside one does not', async ({
      page,
      provider,
    }) => {
      provider.script = { account: newAccount(uniqueAddress(`oauth-next-${name}`)) };
      await toProvider(page, label, '/acme');
      await page.getByRole('link', { name: 'Authorize' }).click();
      await expect(page).toHaveURL(/\/welcome\?next=%2Facme$/);
      const outside = await page.context().browser()?.newContext({ storageState: SIGNED_OUT });
      if (outside === undefined) throw new Error('no browser');
      await provider.attach(outside);
      const second = await outside.newPage();
      const address = uniqueAddress(`oauth-away-${name}`);
      provider.script = { account: newAccount(address) };
      await second.goto(
        `${OAUTH_ORIGIN}/auth/oauth/${name}/start?next=${encodeURIComponent('https://evil.test/x')}`,
      );
      await second.getByRole('link', { name: 'Authorize' }).click();
      await expect(second).toHaveURL(/\/welcome$/);
      await outside.close();
    });
  });

  test.describe(`${label} refusals`, () => {
    test('a state mismatch ends on sign in with no session', async ({ page, provider }) => {
      const address = uniqueAddress(`oauth-state-${name}`);
      await signInThrough(page, provider, each, {
        account: newAccount(address),
        callback: 'wrong_state',
      });
      await expect(page).toHaveURL(new RegExp(`/sign-in\\?error=state&provider=${name}$`));
      await expect(failed(page, label)).toBeVisible();
      await expectNoSession(page, address);
      expect(await usersOf(address)).toBe('0');
    });

    test('a callback opened in another browser signs nobody in, and spends nothing', async ({
      page,
      provider,
    }) => {
      const address = uniqueAddress(`oauth-csrf-${name}`);
      provider.holdCallback = true;
      await signInThrough(page, provider, each, { account: newAccount(address) });
      await expect(page.getByRole('heading', { name: 'Held' })).toBeVisible();
      const callback = provider.callbacks.at(-1) ?? '';
      const other = await page.context().browser()?.newContext({ storageState: SIGNED_OUT });
      if (other === undefined) throw new Error('no browser');
      await provider.attach(other);
      const victim = await other.newPage();
      await victim.goto(callback);
      await expect(victim).toHaveURL(new RegExp(`/sign-in\\?error=state&provider=${name}$`));
      await expectNoSession(victim, address);
      await other.close();
      await page.goto(callback);
      await expect(page).toHaveURL(/\/welcome$/);
    });

    test('the same callback twice is refused the second time', async ({ page, provider }) => {
      const address = uniqueAddress(`oauth-again-${name}`);
      provider.holdCallback = true;
      await signInThrough(page, provider, each, { account: newAccount(address) });
      await expect(page.getByRole('heading', { name: 'Held' })).toBeVisible();
      const callback = provider.callbacks.at(-1) ?? '';
      const stolen = (await page.context().cookies()).filter(
        (cookie) => cookie.name === 'drefyn_oauth' || cookie.name === 'drefyn_pre',
      );
      expect(stolen).toHaveLength(2);
      await page.goto(callback);
      await expect(page).toHaveURL(/\/welcome$/);
      const other = await page.context().browser()?.newContext({ storageState: SIGNED_OUT });
      if (other === undefined) throw new Error('no browser');
      await other.addCookies(stolen);
      await provider.attach(other);
      const thief = await other.newPage();
      await thief.goto(callback);
      await expect(thief).toHaveURL(new RegExp(`/sign-in\\?error=state&provider=${name}$`));
      expect(await hasSession(thief)).toBe(false);
      expect(await sessionsOf(address)).toBe('1');
      await other.close();
    });

    test('a code replayed under a fresh state is refused by the provider', async ({
      page,
      provider,
    }) => {
      const address = uniqueAddress(`oauth-code-${name}`);
      const account = newAccount(address);
      await signInThrough(page, provider, each, { account });
      await expect(page).toHaveURL(/\/welcome$/);
      const code = new URL(provider.callbacks.at(-1) ?? '').searchParams.get('code') ?? '';
      expect(code).not.toBe('');
      await page.context().clearCookies();
      await signInThrough(page, provider, each, { account, code });
      await expect(page).toHaveURL(new RegExp(`/sign-in\\?error=${replayError}&provider=${name}$`));
      await expect(failed(page, label)).toBeVisible();
      expect(await hasSession(page)).toBe(false);
      expect(await sessionsOf(address)).toBe('1');
    });

    test('a provider error ends on sign in with no session', async ({ page, provider }) => {
      const address = uniqueAddress(`oauth-error-${name}`);
      await signInThrough(page, provider, each, {
        account: newAccount(address),
        callback: 'server_error',
      });
      await expect(page).toHaveURL(new RegExp(`/sign-in\\?error=provider&provider=${name}$`));
      await expect(failed(page, label)).toBeVisible();
      await expectNoSession(page, address);
      expect(await usersOf(address)).toBe('0');
    });

    test('a token endpoint outage ends on sign in with no session', async ({ page, provider }) => {
      const address = uniqueAddress(`oauth-down-${name}`);
      await signInThrough(page, provider, each, {
        account: newAccount(address),
        tokenEndpoint: 'down',
      });
      await expect(page).toHaveURL(new RegExp(`/sign-in\\?error=provider&provider=${name}$`));
      await expectNoSession(page, address);
      expect(await usersOf(address)).toBe('0');
    });

    test('denied consent ends on sign in with no session', async ({ page, provider }) => {
      const address = uniqueAddress(`oauth-deny-${name}`);
      provider.script = { account: newAccount(address) };
      await toProvider(page, label);
      await page.getByRole('link', { name: 'Cancel' }).click();
      await expect(page).toHaveURL(new RegExp(`/sign-in\\?error=provider&provider=${name}$`));
      await expect(failed(page, label)).toBeVisible();
      await expectNoSession(page, address);
      expect(await usersOf(address)).toBe('0');
    });
  });

  test.describe(`${label} email linking`, () => {
    test('an unverified address makes no account', async ({ page, provider }) => {
      const address = uniqueAddress(`oauth-unverified-${name}`);
      const account = newAccount(address, { verified: false });
      await signInThrough(page, provider, each, { account });
      await expect(page).toHaveURL(new RegExp(`/sign-in\\?error=unverified&provider=${name}$`));
      await expect(unconfirmed(page, label)).toBeVisible();
      await expectNoSession(page, address);
      expect(await usersOf(address)).toBe('0');
      expect(await identitiesOf(name, account)).toBe('0');
    });

    test('an unverified address never reaches the account that owns it', async ({
      page,
      provider,
    }) => {
      const address = uniqueAddress(`oauth-taken-${name}`);
      await seedPerson(address);
      const account = newAccount(address, { verified: false });
      await signInThrough(page, provider, each, { account });
      await expect(page).toHaveURL(new RegExp(`/sign-in\\?error=unverified&provider=${name}$`));
      await expectNoSession(page, address);
      expect(await identitiesOf(name, account)).toBe('0');
      expect(await countTo(address)).toBe(0);
    });

    test('a verified match links only after the code, then needs no code', async ({
      page,
      provider,
    }) => {
      const address = uniqueAddress(`oauth-link-${name}`);
      await seedPerson(address);
      const account = newAccount(address);
      const seen = await countTo(address);
      await signInThrough(page, provider, each, { account });
      await expect(page).toHaveURL(/\/sign-in\/link$/);
      await expect(page.getByText(`${address} already has a Drefyn account.`)).toBeVisible();
      expect(await identitiesOf(name, account)).toBe('0');
      expect(await hasSession(page)).toBe(false);
      const { code } = await nextMail(address, seen);
      await page.getByLabel('8 digit code').fill(code);
      await page.getByRole('button', { name: `Link ${label} and sign in` }).click();
      await expect(page).toHaveURL(/\/welcome$/);
      expect(await hasSession(page)).toBe(true);
      expect(await identitiesOf(name, account)).toBe('1');
      await page.getByRole('button', { name: 'Sign out' }).click();
      await expect(page).toHaveURL(/\/sign-in$/);
      await signInThrough(page, provider, each, { account });
      await expect(page).toHaveURL(/\/welcome$/);
      expect(await identitiesOf(name, account)).toBe('1');
      expect(await usersOf(address)).toBe('1');
    });

    test('the link code works only in the browser that started it', async ({ page, provider }) => {
      const address = uniqueAddress(`oauth-other-${name}`);
      await seedPerson(address);
      const account = newAccount(address);
      const seen = await countTo(address);
      await signInThrough(page, provider, each, { account });
      await expect(page).toHaveURL(/\/sign-in\/link$/);
      const { code } = await nextMail(address, seen);
      const other = await page.context().browser()?.newContext({ storageState: SIGNED_OUT });
      if (other === undefined) throw new Error('no browser');
      const elsewhere = await other.newPage();
      await elsewhere.goto(`${OAUTH_ORIGIN}/sign-in/link`);
      await elsewhere.getByLabel('8 digit code').fill(code);
      const answered = elsewhere.waitForResponse((reply) => reply.request().method() === 'POST');
      // With no challenge in this browser the page cannot know the provider, and says GitHub.
      await elsewhere.getByRole('button', { name: 'Link GitHub and sign in' }).click();
      await answered;
      await expect(elsewhere).toHaveURL(/\/sign-in\/link$/);
      expect(await hasSession(elsewhere)).toBe(false);
      expect(await identitiesOf(name, account)).toBe('0');
      await other.close();
      await page.getByLabel('8 digit code').fill(code);
      await page.getByRole('button', { name: `Link ${label} and sign in` }).click();
      await expect(page).toHaveURL(/\/welcome$/);
      expect(await identitiesOf(name, account)).toBe('1');
    });

    test('a new subject on a known address is treated as a stranger', async ({
      page,
      provider,
    }) => {
      const address = uniqueAddress(`oauth-subject-${name}`);
      const first = newAccount(address);
      await signInThrough(page, provider, each, { account: first });
      await expect(page).toHaveURL(/\/welcome$/);
      await page.context().clearCookies();
      const reused = newAccount(address);
      await signInThrough(page, provider, each, { account: reused });
      await expect(page).toHaveURL(/\/sign-in\/link$/);
      expect(await hasSession(page)).toBe(false);
      expect(await identitiesOf(name, reused)).toBe('0');
      expect(await usersOf(address)).toBe('1');
    });

    test('a changed address keeps signing in the same account', async ({ page, provider }) => {
      const address = uniqueAddress(`oauth-was-${name}`);
      const changed = uniqueAddress(`oauth-now-${name}`);
      const account = newAccount(address);
      await signInThrough(page, provider, each, { account });
      await expect(page).toHaveURL(/\/welcome$/);
      await page.context().clearCookies();
      const moved = { ...account, email: changed };
      await signInThrough(page, provider, each, { account: moved });
      await expect(page).toHaveURL(/\/welcome$/);
      await expect(page.getByRole('heading', { level: 1 })).toContainText(address);
      expect(await usersOf(changed)).toBe('0');
      expect(await usersOf(address)).toBe('1');
      expect(await sessionsOf(address)).toBe('2');
    });

    test("a change to someone else's address does not reach their account", async ({
      page,
      provider,
    }) => {
      const mine = uniqueAddress(`oauth-mine-${name}`);
      const theirs = uniqueAddress(`oauth-theirs-${name}`);
      await seedPerson(theirs);
      const account = newAccount(mine);
      await signInThrough(page, provider, each, { account });
      await expect(page).toHaveURL(/\/welcome$/);
      await page.context().clearCookies();
      const seen = await countTo(theirs);
      await signInThrough(page, provider, each, { account: { ...account, email: theirs } });
      await expect(page).toHaveURL(/\/welcome$/);
      await expect(page.getByRole('heading', { level: 1 })).toContainText(mine);
      expect(await sessionsOf(theirs)).toBe('0');
      expect(await countTo(theirs)).toBe(seen);
    });

    test('a known identity whose address went unverified is still its own account', async ({
      page,
      provider,
    }) => {
      const address = uniqueAddress(`oauth-lapsed-${name}`);
      const account = newAccount(address);
      await signInThrough(page, provider, each, { account });
      await expect(page).toHaveURL(/\/welcome$/);
      await page.context().clearCookies();
      await signInThrough(page, provider, each, { account: { ...account, verified: false } });
      await expect(page).toHaveURL(/\/welcome$/);
      expect(await sessionsOf(address)).toBe('2');
    });
  });
}

test('a verified GitHub secondary address does not stand in for an unverified primary', async ({
  page,
  provider,
}) => {
  const primary = uniqueAddress('oauth-primary');
  const secondary = uniqueAddress('oauth-secondary');
  await seedPerson(secondary);
  const account = newAccount(primary, {
    verified: false,
    secondary: { email: secondary, verified: true },
  });
  await signInThrough(page, provider, GITHUB, { account });
  await expect(page).toHaveURL(/\/sign-in\?error=unverified&provider=github$/);
  await expectNoSession(page, secondary);
  expect(await countTo(secondary)).toBe(0);
});

test('every provider call in the stack landed on the fake', async ({ page, provider }) => {
  for (const each of PROVIDERS) {
    await signInThrough(page, provider, each, {
      account: newAccount(uniqueAddress(`oauth-wire-${each.name}`)),
    });
    await expect(page).toHaveURL(/\/welcome$/);
    await page.context().clearCookies();
  }
  const log = await fakeLog();
  for (const call of [
    'GET github.com/login/oauth/authorize',
    'POST github.com/login/oauth/access_token',
    'GET api.github.com/user',
    'GET api.github.com/user/emails',
    'GET accounts.google.com/o/oauth2/v2/auth',
    'POST oauth2.googleapis.com/token',
    'GET www.googleapis.com/oauth2/v3/certs',
  ]) {
    expect(log).toContain(call);
  }
});

import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthError, decodeSecret, sha256 } from '../src/index.ts';
import { githubAccount, googleAccount } from './oauth-fakes.ts';
import {
  Jar,
  ORIGIN,
  begin,
  codeOf,
  identity,
  roundTrip,
  setup,
  signedIn,
  user,
  writesTo,
  type Setup,
} from './oauth-fixtures.ts';
import { mutationsOf, runs } from './support.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

let n = 0;
const address = (label: string) => `${label}${String((n += 1))}@example.com`;

// Nothing that makes or proves an account was written.
function nothingWritten(t: Setup) {
  for (const table of ['users', 'identities', 'sessions', 'known_devices']) {
    expect(writesTo(t, table), table).toEqual([]);
  }
  expect(t.sessions.sessions.startSession).not.toHaveBeenCalled();
}

describe('startOAuth', () => {
  it('builds the redirect URI from the app origin only, whatever the request carried', async () => {
    const t = setup();
    for (const provider of ['github', 'google'] as const) {
      const jar = new Jar();
      // Fields the dashboard could have copied from forged headers; auth has no way to read them.
      const forged = {
        ...jar.context(),
        host: 'evil.example',
        headers: {
          host: 'evil.example',
          'x-forwarded-host': 'evil.example',
          'x-forwarded-proto': 'http',
        },
        url: 'http://evil.example/auth/oauth/github/start',
      };
      const started = await t.oauth.startOAuth(forged, { provider, purpose: 'sign_in' });
      if (!started.ok) throw started.error;
      expect(started.value.redirectTo.searchParams.get('redirect_uri')).toBe(
        `${ORIGIN}/auth/oauth/${provider}/callback`,
      );
    }
  });

  it('always asks for PKCE S256 and binds the state to a cookie', async () => {
    const t = setup();
    const { url, jar } = await begin(t, 'github');
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('scope')).toBe('read:user user:email');
    expect(url.searchParams.get('client_id')).toBe('fake-github-client');
    expect(url.searchParams.get('response_type')).toBe('code');
    const state = url.searchParams.get('state');
    expect(state).not.toBeNull();
    expect(jar.cookies.get(t.config.cookies.oauth)).toBe(state);
    expect(jar.cookies.get(t.config.cookies.pre)).toBeDefined();
    // GitHub is not OpenID, so no nonce is asked for or stored.
    expect(url.searchParams.has('nonce')).toBe(false);
    expect(t.db.tables.oauth_states[0]?.['nonce']).toBeNull();
  });

  it('stores the hash of the state, the verifier and the binding, never the raw state', async () => {
    const t = setup();
    const { url, jar } = await begin(t, 'google', { returnTo: '/acme/docs?tab=1' });
    const state = url.searchParams.get('state') ?? '';
    const row = t.db.tables.oauth_states[0] ?? {};
    expect(row['state_hash']).toEqual(sha256(Buffer.from(state)));
    expect(row['provider']).toBe('google');
    expect(row['purpose']).toBe('sign_in');
    expect(row['link_user_id']).toBeNull();
    expect(row['return_to']).toBe('/acme/docs?tab=1');
    expect(row['nonce']).toBe(url.searchParams.get('nonce'));
    expect(String(row['code_verifier'])).toMatch(/^[0-9a-z]{52}$/);
    expect(url.toString()).not.toContain(String(row['code_verifier']));
    const pre = jar.cookies.get(t.config.cookies.pre) ?? '';
    expect(row['browser_hash']).toEqual(sha256(decodeSecret(pre) ?? Buffer.alloc(1)));
    expect(t.db.sent()).not.toContain(`"${state}"`);
  });

  it('asks Google for an ID token with a nonce, and step up for a fresh sign in', async () => {
    const t = setup();
    const plain = await begin(t, 'google');
    expect(plain.url.searchParams.get('scope')).toBe('openid email');
    expect(plain.url.searchParams.get('nonce')).toMatch(/^[0-9a-z]{52}$/);
    expect(plain.url.searchParams.has('prompt')).toBe(false);
    expect(plain.url.searchParams.has('max_age')).toBe(false);
    const id = user(t, address('stepper'));
    const { jar, session } = await signedIn(t, id);
    const step = await begin(t, 'google', { jar, purpose: 'step_up', session });
    expect(step.url.searchParams.get('prompt')).toBe('login');
    expect(step.url.searchParams.get('max_age')).toBe('0');
  });

  it('drops a returnTo that leaves the origin', async () => {
    const t = setup();
    await begin(t, 'github', { returnTo: '//evil.example/x' });
    expect(t.db.tables.oauth_states[0]?.['return_to']).toBe('/');
  });

  it('refuses a provider that is not configured', async () => {
    const t = setup({
      env: { DREFYN_AUTH_GOOGLE_CLIENT_ID: '', DREFYN_AUTH_GOOGLE_CLIENT_SECRET: '' },
    });
    const started = await t.oauth.startOAuth(new Jar().context(), {
      provider: 'google',
      purpose: 'sign_in',
    });
    expect(codeOf(started)).toBe('AUTH_OAUTH_DISABLED');
    const done = await t.oauth.completeOAuth(new Jar().context(), {
      provider: 'google',
      query: new URLSearchParams({ code: 'x', state: 'y' }),
    });
    expect(codeOf(done)).toBe('AUTH_OAUTH_DISABLED');
  });

  it('refuses an unknown provider or purpose', async () => {
    const t = setup();
    const b = new Jar().context();
    const bad = [
      { provider: 'gitlab', purpose: 'sign_in' },
      { provider: 'github', purpose: 'delete' },
    ] as unknown as Parameters<typeof t.oauth.startOAuth>[1][];
    for (const input of bad)
      expect(codeOf(await t.oauth.startOAuth(b, input))).toBe('AUTH_INPUT_INVALID');
    const done = await t.oauth.completeOAuth(b, {
      provider: 'gitlab' as 'github',
      query: new URLSearchParams(),
    });
    expect(codeOf(done)).toBe('AUTH_INPUT_INVALID');
  });

  it('needs a session, recently proved, to link', async () => {
    const t = setup();
    const b = new Jar().context();
    expect(codeOf(await t.oauth.startOAuth(b, { provider: 'github', purpose: 'link' }))).toBe(
      'AUTH_SESSION_INVALID',
    );
    expect(codeOf(await t.oauth.startOAuth(b, { provider: 'github', purpose: 'step_up' }))).toBe(
      'AUTH_SESSION_INVALID',
    );
    const { jar, session } = await signedIn(t, user(t, address('stale')));
    t.sessions.setRecent(false);
    const started = await t.oauth.startOAuth(jar.context(), {
      provider: 'github',
      purpose: 'link',
      session,
    });
    expect(codeOf(started)).toBe('AUTH_RECENT_AUTH_REQUIRED');
    expect(t.db.tables.oauth_states).toEqual([]);
  });

  it('counts starts per IP and writes nothing once limited', async () => {
    const t = setup();
    t.reserve.mockRejectedValueOnce(new AuthError('AUTH_RATE_LIMITED'));
    const started = await t.oauth.startOAuth(new Jar().context(), {
      provider: 'github',
      purpose: 'sign_in',
    });
    expect(codeOf(started)).toBe('AUTH_RATE_LIMITED');
    expect(t.reserve.mock.calls[0]?.[0]).toBe('oauth_start');
    expect(t.db.tables.oauth_states).toEqual([]);
  });

  it('answers AUTH_UNAVAILABLE when the state cannot be stored', async () => {
    const t = setup();
    t.db.fail('insert', 'oauth_states');
    const started = await t.oauth.startOAuth(new Jar().context(), {
      provider: 'github',
      purpose: 'sign_in',
    });
    expect(codeOf(started)).toBe('AUTH_UNAVAILABLE');
  });
});

describe('the callback refuses', () => {
  const account = () => githubAccount(address('victim'));

  it('a missing state', async () => {
    const t = setup();
    const { done } = await roundTrip(t, account(), {
      edit: (q) => {
        q.delete('state');
      },
    });
    expect(codeOf(done)).toBe('AUTH_OAUTH_STATE_INVALID');
    nothingWritten(t);
  });

  it('a state that does not match the cookie', async () => {
    const t = setup();
    const { done } = await roundTrip(t, account(), {
      edit: (_q, jar) => {
        jar.cookies.set(t.config.cookies.oauth, 'a'.repeat(52));
      },
    });
    expect(codeOf(done)).toBe('AUTH_OAUTH_STATE_INVALID');
    nothingWritten(t);
  });

  it('a browser with no state cookie at all', async () => {
    const t = setup();
    const { done } = await roundTrip(t, account(), {
      edit: (_q, jar) => {
        jar.cookies.delete(t.config.cookies.oauth);
      },
    });
    expect(codeOf(done)).toBe('AUTH_OAUTH_STATE_INVALID');
    nothingWritten(t);
  });

  it('a state and cookie carried to another browser', async () => {
    const t = setup();
    const { done } = await roundTrip(t, account(), {
      edit: (_q, jar) => {
        jar.cookies.set(t.config.cookies.pre, 'b'.repeat(52));
      },
    });
    expect(codeOf(done)).toBe('AUTH_OAUTH_STATE_INVALID');
    nothingWritten(t);
    const second = await roundTrip(t, account(), {
      edit: (_q, jar) => {
        jar.cookies.delete(t.config.cookies.pre);
      },
    });
    expect(codeOf(second.done)).toBe('AUTH_OAUTH_STATE_INVALID');
  });

  it('a state started for another provider', async () => {
    const t = setup();
    const { done } = await roundTrip(t, account(), { callbackProvider: 'google' });
    expect(codeOf(done)).toBe('AUTH_OAUTH_STATE_INVALID');
    nothingWritten(t);
    // The state was spent by the attempt: single use holds even for a refusal.
    expect(t.db.tables.oauth_states).toEqual([]);
  });

  it('a replayed state', async () => {
    const t = setup();
    const first = await roundTrip(t, account());
    expect(codeOf(first.done)).toBe('ok');
    const again = await t.oauth.completeOAuth(first.jar.context(), {
      provider: 'github',
      query: first.query,
    });
    // The first success cleared the cookie; put it back as an attacker holding both would.
    first.jar.cookies.set(t.config.cookies.oauth, first.query.get('state') ?? '');
    const replay = await t.oauth.completeOAuth(first.jar.context(), {
      provider: 'github',
      query: first.query,
    });
    expect(codeOf(again)).toBe('AUTH_OAUTH_STATE_INVALID');
    expect(codeOf(replay)).toBe('AUTH_OAUTH_STATE_INVALID');
    expect(t.sessions.sessions.startSession).toHaveBeenCalledTimes(1);
  });

  it('an expired state', async () => {
    const t = setup();
    const { done } = await roundTrip(t, account(), {
      edit: () => {
        const row = t.db.tables.oauth_states[0];
        if (row !== undefined) row['live'] = false;
      },
    });
    expect(codeOf(done)).toBe('AUTH_OAUTH_STATE_INVALID');
    nothingWritten(t);
  });

  it('a token request with no PKCE verifier', async () => {
    const t = setup({ fakes: { dropVerifier: true } });
    const { done } = await roundTrip(t, account());
    expect(codeOf(done)).toBe('AUTH_OAUTH_PROVIDER_ERROR');
    nothingWritten(t);
  });

  it('a code minted for another PKCE challenge, as an injected code is', async () => {
    const t = setup();
    const { done } = await roundTrip(t, account(), {
      edit: (q) => {
        q.set(
          'code',
          t.fakes.mintCode(account(), `${ORIGIN}/auth/oauth/github/callback`, 'x'.repeat(43)),
        );
      },
    });
    expect(codeOf(done)).toBe('AUTH_OAUTH_PROVIDER_ERROR');
    nothingWritten(t);
  });

  it('a stored verifier that was changed', async () => {
    const t = setup();
    const { done } = await roundTrip(t, account(), {
      edit: () => {
        const row = t.db.tables.oauth_states[0];
        if (row !== undefined) row['code_verifier'] = 'z'.repeat(52);
      },
    });
    expect(codeOf(done)).toBe('AUTH_OAUTH_PROVIDER_ERROR');
    nothingWritten(t);
  });

  it.each(['other', 'absent'] as const)('an ID token whose nonce is %s', async (nonce) => {
    const t = setup({ fakes: { nonce } });
    const { done } = await roundTrip(t, googleAccount(address('nonce')));
    expect(codeOf(done)).toBe('AUTH_OAUTH_PROVIDER_ERROR');
    nothingWritten(t);
  });

  it('an unverified GitHub primary address', async () => {
    const t = setup();
    const { done } = await roundTrip(t, githubAccount(address('unverified'), { verified: false }));
    expect(codeOf(done)).toBe('AUTH_OAUTH_EMAIL_UNVERIFIED');
    nothingWritten(t);
  });

  it('an unverified Google address', async () => {
    const t = setup();
    const { done } = await roundTrip(t, googleAccount(address('unverified'), { verified: false }));
    expect(codeOf(done)).toBe('AUTH_OAUTH_EMAIL_UNVERIFIED');
    nothingWritten(t);
  });

  it('an error the provider sent back instead of a code', async () => {
    const t = setup();
    const { done } = await roundTrip(t, account(), {
      edit: (q) => {
        q.delete('code');
        q.set('error', 'access_denied');
      },
    });
    expect(codeOf(done)).toBe('AUTH_OAUTH_PROVIDER_ERROR');
    nothingWritten(t);
  });

  it('when the state store is down', async () => {
    const t = setup();
    const { done } = await roundTrip(t, account(), {
      edit: () => {
        t.db.fail('delete', 'oauth_states');
      },
    });
    expect(codeOf(done)).toBe('AUTH_UNAVAILABLE');
    nothingWritten(t);
  });
});

describe('any mutation of the state or the verifier is refused', () => {
  // A fixed random source, so the state and verifier are known before the property runs.
  const fixed = (bytes: number) => new Uint8Array(bytes).fill(0x5a);

  it('state: every single character edit, in the query alone or with the cookie', async () => {
    const t = setup({ deps: { random: fixed } });
    const probe = await begin(t, 'github');
    const state = probe.url.searchParams.get('state') ?? '';
    await fc.assert(
      fc.asyncProperty(mutationsOf(state), fc.boolean(), async (mutation, cookieToo) => {
        t.db.tables.oauth_states.splice(0);
        const { jar, url } = await begin(t, 'github');
        const { query } = t.fakes.approve(url, githubAccount(address('prop')));
        query.set('state', mutation.value);
        if (cookieToo) jar.cookies.set(t.config.cookies.oauth, mutation.value);
        const done = await t.oauth.completeOAuth(jar.context(), { provider: 'github', query });
        expect(codeOf(done)).toBe('AUTH_OAUTH_STATE_INVALID');
      }),
      { ...runs, numRuns: 60 },
    );
    expect(t.sessions.sessions.startSession).not.toHaveBeenCalled();
  });

  it('verifier: every single character edit of the stored verifier', async () => {
    const t = setup({ deps: { random: fixed } });
    await begin(t, 'github');
    const verifier = String(t.db.tables.oauth_states[0]?.['code_verifier']);
    await fc.assert(
      fc.asyncProperty(mutationsOf(verifier), async (mutation) => {
        t.db.tables.oauth_states.splice(0);
        const { jar, url } = await begin(t, 'github');
        const row = t.db.tables.oauth_states[0];
        if (row === undefined) throw new Error('no state row');
        row['code_verifier'] = mutation.value;
        const { query } = t.fakes.approve(url, githubAccount(address('prop')));
        const done = await t.oauth.completeOAuth(jar.context(), { provider: 'github', query });
        expect(codeOf(done)).not.toBe('ok');
      }),
      { ...runs, numRuns: 60 },
    );
    expect(t.sessions.sessions.startSession).not.toHaveBeenCalled();
  });
});

describe('signing in', () => {
  it('creates a user and a GitHub identity keyed by the numeric id, never the login', async () => {
    const t = setup();
    const email = address('new');
    const account = githubAccount(email, { id: 583_231, login: 'octocat' });
    const { done, jar } = await roundTrip(t, account, { returnTo: '/acme' });
    if (!done.ok) throw done.error;
    expect(done.value.kind).toBe('signed_in');
    if (done.value.kind !== 'signed_in') return;
    expect(done.value.session.method).toBe('github');
    expect(done.value.returnTo).toBe('/acme');
    expect(t.db.tables.users).toMatchObject([{ email, email_normalized: email }]);
    expect(t.db.tables.identities).toMatchObject([
      { provider: 'github', provider_subject: '583231', provider_email_normalized: email },
    ]);
    expect(JSON.stringify(t.db.tables.identities)).not.toContain('octocat');
    expect(jar.cookies.has(t.config.cookies.oauth)).toBe(false);
    expect(t.db.tables.oauth_states).toEqual([]);
  });

  it('records the browser as a known device, as email sign in does', async () => {
    const t = setup();
    const { done, jar } = await roundTrip(t, githubAccount(address('device')));
    expect(codeOf(done)).toBe('ok');
    expect(writesTo(t, 'known_devices').length).toBeGreaterThan(0);
    expect(jar.cookies.get(t.config.cookies.device)).toMatch(/^[0-9a-z]{52}$/);
  });

  it('uses only the primary verified GitHub address', async () => {
    const t = setup();
    const email = address('primary');
    const { done } = await roundTrip(t, githubAccount(email));
    expect(codeOf(done)).toBe('ok');
    expect(t.db.tables.users[0]?.['email_normalized']).toBe(email);
  });

  it('signs a known identity in as its user and makes no new one', async () => {
    const t = setup();
    const email = address('known');
    const id = user(t, email);
    const account = githubAccount(email);
    identity(t, id, account);
    const { done } = await roundTrip(t, account);
    if (!done.ok) throw done.error;
    expect(done.value.kind === 'signed_in' && done.value.session.userId).toBe(id);
    expect(writesTo(t, 'users')).toEqual([]);
    expect(writesTo(t, 'identities')).toEqual([]);
  });

  it('signs a known identity in even when its provider address changed', async () => {
    const t = setup();
    const id = user(t, address('moved'));
    const account = githubAccount(address('elsewhere'), { id: 77 });
    identity(t, id, account);
    const moved = githubAccount(address('unverified-now'), { id: 77, verified: false });
    const { done } = await roundTrip(t, moved);
    expect(done.ok && done.value.kind === 'signed_in' && done.value.session.userId).toBe(id);
  });

  it('creates a Google user keyed by sub', async () => {
    const t = setup();
    const email = address('g');
    const account = googleAccount(email, { sub: '109876543210987654321' });
    const { done } = await roundTrip(t, account);
    expect(codeOf(done)).toBe('ok');
    expect(t.db.tables.identities).toMatchObject([
      {
        provider: 'google',
        provider_subject: '109876543210987654321',
        provider_email_normalized: email,
      },
    ]);
  });

  it('refuses a new address when sign up is closed, only after the provider proved it', async () => {
    const t = setup({ env: { DREFYN_AUTH_SIGNUP: 'closed' } });
    const { done } = await roundTrip(t, githubAccount(address('closed')));
    expect(codeOf(done)).toBe('AUTH_SIGNUP_CLOSED');
    nothingWritten(t);
  });

  it('lets a new address in on invite only when the browser holds its invitation', async () => {
    const allowsSignUp = vi.fn(() => Promise.resolve(true));
    const t = setup({
      env: { DREFYN_AUTH_SIGNUP: 'invite_only' },
      deps: { invitations: { allowsSignUp } },
    });
    const email = address('invited');
    const { done } = await roundTrip(t, googleAccount(email), {
      edit: (_, jar) => {
        jar.cookies.set(t.config.cookies.invite, 'held-token');
      },
    });
    expect(codeOf(done)).toBe('ok');
    expect(allowsSignUp).toHaveBeenCalledWith('held-token', email);
    const nobody = setup({ env: { DREFYN_AUTH_SIGNUP: 'invite_only' } });
    expect(codeOf((await roundTrip(nobody, googleAccount(address('uninvited')))).done)).toBe(
      'AUTH_SIGNUP_CLOSED',
    );
  });

  it('refuses a provider address the address rules refuse', async () => {
    const t = setup();
    const { done } = await roundTrip(t, githubAccount('not an address'));
    expect(codeOf(done)).toBe('AUTH_INPUT_INVALID');
    nothingWritten(t);
  });

  it('signs in as the identity’s user when it appeared between start and callback', async () => {
    const t = setup();
    const account = githubAccount(address('race'));
    const { done } = await roundTrip(t, account, {
      edit: () => {
        identity(t, user(t, address('winner')), account);
      },
    });
    // The identity existed by the time of the lookup: that is just a known identity.
    expect(codeOf(done)).toBe('ok');
  });
});

describe('a verified provider address that matches an existing user', () => {
  it('is never linked without the email code, and the code names the provider and account', async () => {
    const t = setup();
    const email = address('existing');
    const existing = user(t, email);
    const account = githubAccount(email, { id: 4242, login: 'mona' });
    const { done, jar } = await roundTrip(t, account, { returnTo: '/acme' });
    if (!done.ok) throw done.error;
    expect(done.value.kind).toBe('link_pending');
    expect(t.db.tables.identities).toEqual([]);
    expect(t.sessions.sessions.startSession).not.toHaveBeenCalled();
    if (done.value.kind !== 'link_pending') return;
    await done.value.send();
    expect(t.mail.sent).toHaveLength(1);
    const mail = t.mail.sent[0];
    expect(mail?.to).toBe(email);
    expect(mail?.purpose).toBe('link_identity');
    expect(mail?.linking).toEqual({ provider: 'github', account: 'mona' });
    expect(t.db.tables.email_challenges).toMatchObject([
      {
        purpose: 'link_identity',
        user_id: existing,
        pending_provider: 'github',
        pending_subject: '4242',
        return_to: '/acme',
      },
    ]);
    expect(jar.cookies.has(t.config.cookies.oauth)).toBe(false);
    expect(jar.cookies.has(t.config.cookies.pre)).toBe(true);
  });

  it('links and signs in once the code is proved in the same browser', async () => {
    const t = setup();
    const email = address('linker');
    const existing = user(t, email);
    const account = googleAccount(email, { sub: '555' });
    const { done, jar } = await roundTrip(t, account);
    if (!done.ok || done.value.kind !== 'link_pending') throw new Error('expected link_pending');
    await done.value.send();
    const fragment = t.mail.sent[0]?.link.hash.slice(1) ?? '';
    const [challenge = '', code = ''] = fragment.split('.');
    const verified = await t.email.verifyLinkCode(jar.context(), null, { challenge, code });
    if (!verified.ok) throw verified.error;
    expect(verified.value.kind).toBe('signed_in');
    if (verified.value.kind !== 'signed_in') return;
    expect(verified.value.signedIn.session.userId).toBe(existing);
    expect(verified.value.signedIn.session.method).toBe('google');
    expect(t.db.tables.identities).toMatchObject([
      {
        user_id: existing,
        provider: 'google',
        provider_subject: '555',
        provider_email_normalized: email,
      },
    ]);
    await verified.value.signedIn.send?.();
    expect(t.mail.notices).toMatchObject([
      { to: email, notice: { kind: 'identity_linked', provider: 'google', account: email } },
    ]);
    // From now on the identity signs straight in.
    const next = await roundTrip(t, account);
    expect(next.done.ok && next.done.value.kind).toBe('signed_in');
  });

  it('a typed link code links too', async () => {
    const t = setup();
    const email = address('typed');
    user(t, email);
    const { done, jar } = await roundTrip(t, githubAccount(email));
    if (!done.ok || done.value.kind !== 'link_pending') throw new Error('expected link_pending');
    await done.value.send();
    const verified = await t.email.verifyEmailCode(jar.context(), {
      code: t.mail.sent[0]?.code ?? '',
    });
    expect(verified.ok && verified.value.session.method).toBe('github');
    expect(t.db.tables.identities).toHaveLength(1);
  });

  it('refuses the code from another browser and links nothing', async () => {
    const t = setup();
    const email = address('other-browser');
    user(t, email);
    const { done } = await roundTrip(t, githubAccount(email));
    if (!done.ok || done.value.kind !== 'link_pending') throw new Error('expected link_pending');
    await done.value.send();
    const [challenge = '', code = ''] = (t.mail.sent[0]?.link.hash.slice(1) ?? '').split('.');
    const stranger = new Jar();
    stranger.cookies.set(t.config.cookies.pre, 'c'.repeat(52));
    const verified = await t.email.verifyLinkCode(stranger.context(), null, { challenge, code });
    expect(codeOf(verified)).toBe('AUTH_CHALLENGE_BINDING');
    expect(t.db.tables.identities).toEqual([]);
  });

  it('answers a code whose identity was taken meanwhile like a wrong code', async () => {
    const t = setup();
    const email = address('taken');
    user(t, email);
    const account = githubAccount(email);
    const { done, jar } = await roundTrip(t, account);
    if (!done.ok || done.value.kind !== 'link_pending') throw new Error('expected link_pending');
    await done.value.send();
    identity(t, user(t, address('someone')), account);
    const [challenge = '', code = ''] = (t.mail.sent[0]?.link.hash.slice(1) ?? '').split('.');
    const verified = await t.email.verifyLinkCode(jar.context(), null, { challenge, code });
    expect(codeOf(verified)).toBe('AUTH_CODE_INVALID');
    expect(t.sessions.sessions.startSession).not.toHaveBeenCalled();
  });

  it('counts the link mail against the address and IP send limits', async () => {
    const t = setup();
    const email = address('limited');
    user(t, email);
    t.reserve.mockImplementation((bucket) =>
      bucket === 'email_send'
        ? Promise.reject(new AuthError('AUTH_RATE_LIMITED'))
        : Promise.resolve(),
    );
    const { done } = await roundTrip(t, githubAccount(email));
    expect(codeOf(done)).toBe('AUTH_RATE_LIMITED');
    expect(t.db.tables.email_challenges).toEqual([]);
  });
});

describe('Google ID token signatures', () => {
  it('accepts a valid signature and fetches the JWKS once across two sign ins', async () => {
    const t = setup();
    expect(codeOf((await roundTrip(t, googleAccount(address('one')))).done)).toBe('ok');
    expect(codeOf((await roundTrip(t, googleAccount(address('two')))).done)).toBe('ok');
    expect(t.fakes.jwksFetches).toBe(1);
  });

  it.each(['flipped', 'foreign'] as const)('refuses a %s signature', async (signature) => {
    const t = setup({ fakes: { signature } });
    const { done } = await roundTrip(t, googleAccount(address('sig')));
    expect(codeOf(done)).toBe('AUTH_OAUTH_PROVIDER_ERROR');
    nothingWritten(t);
  });

  it('answers a JWKS outage with a provider error and writes no row', async () => {
    const t = setup({ fakes: { jwks: 'down' } });
    const { done } = await roundTrip(t, googleAccount(address('jwks')));
    expect(codeOf(done)).toBe('AUTH_OAUTH_PROVIDER_ERROR');
    nothingWritten(t);
    expect(t.db.tables.oauth_states).toEqual([]);
  });
});

describe('GitHub token errors that arrive as HTTP 200', () => {
  it.each([
    ['bad_verification_code', 'AUTH_OAUTH_STATE_INVALID'],
    ['expired_token', 'AUTH_OAUTH_STATE_INVALID'],
    ['unsupported_grant_type', 'AUTH_OAUTH_PROVIDER_ERROR'],
  ])('maps %s to %s and logs nothing about it', async (error, expected) => {
    const t = setup({ fakes: { githubTokenError: error } });
    const { done } = await roundTrip(t, githubAccount(address('err')));
    expect(codeOf(done)).toBe(expected);
    expect(t.logs.filter((l) => l.event === 'auth.oauth_misconfigured')).toEqual([]);
    nothingWritten(t);
  });

  it.each(['incorrect_client_credentials', 'redirect_uri_mismatch', 'application_suspended'])(
    'maps %s to a provider error and tells the operator, with provider and code only',
    async (error) => {
      const t = setup({ fakes: { githubTokenError: error } });
      const { done } = await roundTrip(t, githubAccount(address('misconfigured')));
      expect(codeOf(done)).toBe('AUTH_OAUTH_PROVIDER_ERROR');
      expect(t.logs.filter((l) => l.event === 'auth.oauth_misconfigured')).toEqual([
        { level: 'warn', event: 'auth.oauth_misconfigured', fields: { provider: 'github', error } },
      ]);
      const text = JSON.stringify(t.logs);
      expect(text).not.toContain('fake ');
      expect(text).not.toContain('docs.github.com');
    },
  );

  it('logs a code outside the expected shape as other', async () => {
    const t = setup({ fakes: { githubTokenError: 'Not-A-Code' } });
    const { done } = await roundTrip(t, githubAccount(address('odd')));
    expect(codeOf(done)).toBe('AUTH_OAUTH_PROVIDER_ERROR');
    expect(JSON.stringify(t.logs)).not.toContain('Not-A-Code');
  });
});

describe('step up', () => {
  async function stepUp(
    t: Setup,
    owner: ReturnType<typeof user>,
    account: Parameters<typeof roundTrip>[1],
  ) {
    const { jar, session } = await signedIn(t, owner);
    return roundTrip(t, account, { jar, purpose: 'step_up', session });
  }

  it('is refused for an identity not linked to the session user', async () => {
    const t = setup();
    const me = user(t, address('me'));
    const theirs = googleAccount(address('them'));
    identity(t, user(t, address('them-user')), theirs);
    const { done } = await stepUp(t, me, theirs);
    expect(codeOf(done)).toBe('AUTH_STEP_UP_IDENTITY_MISMATCH');
    const unknown = await stepUp(t, me, googleAccount(address('nobody')));
    expect(codeOf(unknown.done)).toBe('AUTH_STEP_UP_IDENTITY_MISMATCH');
    expect(writesTo(t, 'sessions').filter((s) => /^\s*update/i.test(s.sql))).toEqual([]);
  });

  it('with Google sends prompt=login and max_age=0 and records google', async () => {
    const t = setup({ fakes: { authTimeAgoSeconds: 10 } });
    const email = address('g-step');
    const me = user(t, email);
    const account = googleAccount(email);
    identity(t, me, account);
    const { done, asked } = await stepUp(t, me, account);
    expect(asked.get('prompt')).toBe('login');
    expect(asked.get('max_age')).toBe('0');
    if (!done.ok) throw done.error;
    expect(done.value.kind).toBe('stepped_up');
    expect(done.value.kind === 'stepped_up' && done.value.session.stepUpMethod).toBe('google');
  });

  it('with Google refuses an auth_time older than 5 minutes', async () => {
    const t = setup({ fakes: { authTimeAgoSeconds: 301 } });
    const email = address('g-old');
    const me = user(t, email);
    const account = googleAccount(email);
    identity(t, me, account);
    const { done } = await stepUp(t, me, account);
    expect(codeOf(done)).toBe('AUTH_RECENT_AUTH_REQUIRED');
    expect(writesTo(t, 'sessions').filter((s) => /^\s*update/i.test(s.sql))).toEqual([]);
  });

  it('with GitHub is refused at the callback when another step up method appeared', async () => {
    const off = setup({ env: { DREFYN_AUTH_EMAIL: 'off' } });
    const withPassword = user(off, address('gh-pass'));
    const ghPass = githubAccount(address('gh-pass-account'));
    identity(off, withPassword, ghPass);
    const first = await signedIn(off, withPassword);
    const password = await roundTrip(off, ghPass, {
      ...first,
      purpose: 'step_up',
      edit: () => {
        off.db.tables.password_credentials.push({ user_id: withPassword, phc: '$argon2id$x' });
      },
    });
    expect(codeOf(password.done)).toBe('AUTH_FORBIDDEN');
    const withGoogle = user(off, address('gh-google'));
    const ghGoogle = githubAccount(address('gh-google-account'));
    identity(off, withGoogle, ghGoogle);
    const second = await signedIn(off, withGoogle);
    const google = await roundTrip(off, ghGoogle, {
      ...second,
      purpose: 'step_up',
      edit: () => {
        identity(off, withGoogle, googleAccount(address('gh-google-g')));
      },
    });
    expect(codeOf(google.done)).toBe('AUTH_FORBIDDEN');
    expect(writesTo(off, 'sessions').filter((s) => /^\s*update/i.test(s.sql))).toEqual([]);
  });

  it('with GitHub is refused at start while email is on, before the round trip', async () => {
    const t = setup();
    const me = user(t, address('gh-early'));
    identity(t, me, githubAccount(address('gh-early-account')));
    const { jar, session } = await signedIn(t, me);
    const started = await t.oauth.startOAuth(jar.context(), {
      provider: 'github',
      purpose: 'step_up',
      session,
    });
    expect(codeOf(started)).toBe('AUTH_FORBIDDEN');
  });

  it('with GitHub is recorded as github_session for a GitHub only user with email off', async () => {
    const t = setup({ env: { DREFYN_AUTH_EMAIL: 'off' } });
    const me = user(t, address('gh-only'));
    const account = githubAccount(address('gh-only-account'));
    identity(t, me, account);
    const { done } = await stepUp(t, me, account);
    if (!done.ok) throw done.error;
    expect(done.value.kind === 'stepped_up' && done.value.session.stepUpMethod).toBe(
      'github_session',
    );
  });

  it('is refused when the browser’s session is not the user who started it', async () => {
    const t = setup({ fakes: { authTimeAgoSeconds: 5 } });
    const email = address('swap');
    const me = user(t, email);
    const account = googleAccount(email);
    identity(t, me, account);
    const { jar, session } = await signedIn(t, me);
    const { done } = await roundTrip(t, account, {
      jar,
      purpose: 'step_up',
      session,
      edit: (_q, j) => {
        j.cookies.set(t.config.cookies.session, 's.not-a-session');
      },
    });
    expect(codeOf(done)).toBe('AUTH_SESSION_INVALID');
  });
});

describe('linking while signed in', () => {
  it('links a new identity to the session user and sends a security notice', async () => {
    const t = setup();
    const email = address('linking');
    const me = user(t, email);
    const { jar, session } = await signedIn(t, me);
    const account = githubAccount(address('my-github'), { login: 'me-on-github' });
    const { done } = await roundTrip(t, account, {
      jar,
      purpose: 'link',
      session,
      returnTo: '/account',
    });
    if (!done.ok) throw done.error;
    expect(done.value.kind).toBe('linked');
    if (done.value.kind !== 'linked') return;
    expect(done.value.returnTo).toBe('/account');
    expect(t.db.tables.identities).toMatchObject([{ user_id: me, provider: 'github' }]);
    expect(t.mail.notices).toEqual([]);
    await done.value.send();
    expect(t.mail.notices).toMatchObject([
      {
        to: email,
        notice: { kind: 'identity_linked', provider: 'github', account: account.emails[0]?.email },
      },
    ]);
  });

  it('needs the recent sign in at the callback too', async () => {
    const t = setup();
    const me = user(t, address('stale-link'));
    const { jar, session } = await signedIn(t, me);
    const { done } = await roundTrip(t, githubAccount(address('stale-gh')), {
      jar,
      purpose: 'link',
      session,
      edit: () => {
        t.sessions.setRecent(false);
      },
    });
    expect(codeOf(done)).toBe('AUTH_RECENT_AUTH_REQUIRED');
    expect(t.db.tables.identities).toEqual([]);
  });

  it('refuses an identity that belongs to someone else, or a second one of a provider', async () => {
    const t = setup();
    const me = user(t, address('mine'));
    const theirs = githubAccount(address('theirs'));
    identity(t, user(t, address('owner')), theirs);
    const { jar, session } = await signedIn(t, me);
    expect(codeOf((await roundTrip(t, theirs, { jar, purpose: 'link', session })).done)).toBe(
      'AUTH_FORBIDDEN',
    );
    identity(t, me, githubAccount(address('first-gh')));
    const second = await roundTrip(t, githubAccount(address('second-gh')), {
      jar,
      purpose: 'link',
      session,
    });
    expect(codeOf(second.done)).toBe('AUTH_FORBIDDEN');
    expect(t.mail.notices).toEqual([]);
  });

  it('treats linking an identity already linked to this user as done, with no notice', async () => {
    const t = setup();
    const me = user(t, address('again'));
    const account = githubAccount(address('again-gh'));
    identity(t, me, account);
    const { jar, session } = await signedIn(t, me);
    const { done } = await roundTrip(t, account, { jar, purpose: 'link', session });
    if (!done.ok || done.value.kind !== 'linked') throw new Error('expected linked');
    await done.value.send();
    expect(t.mail.notices).toEqual([]);
  });
});

describe('unlinking', () => {
  it('removes the identity and sends a security notice', async () => {
    const t = setup();
    const email = address('unlink');
    const me = user(t, email);
    identity(t, me, googleAccount(email));
    const { session } = await signedIn(t, me);
    const result = await t.oauth.unlinkIdentity(session, { provider: 'google' });
    if (!result.ok) throw result.error;
    expect(t.db.tables.identities).toEqual([]);
    await result.value.send();
    expect(t.mail.notices).toMatchObject([
      { to: email, notice: { kind: 'identity_unlinked', provider: 'google', account: email } },
    ]);
  });

  it('needs a recent sign in', async () => {
    const t = setup();
    const me = user(t, address('unlink-stale'));
    identity(t, me, googleAccount(address('unlink-stale-g')));
    const { session } = await signedIn(t, me);
    t.sessions.setRecent(false);
    expect(codeOf(await t.oauth.unlinkIdentity(session, { provider: 'google' }))).toBe(
      'AUTH_RECENT_AUTH_REQUIRED',
    );
    expect(t.db.tables.identities).toHaveLength(1);
  });

  it('answers not found for a provider that is not linked', async () => {
    const t = setup();
    const { session } = await signedIn(t, user(t, address('none')));
    expect(codeOf(await t.oauth.unlinkIdentity(session, { provider: 'github' }))).toBe(
      'AUTH_NOT_FOUND',
    );
    expect(codeOf(await t.oauth.unlinkIdentity(session, { provider: 'gitlab' as 'github' }))).toBe(
      'AUTH_INPUT_INVALID',
    );
  });

  it('refuses to remove the last way to sign in when email is off', async () => {
    const t = setup({ env: { DREFYN_AUTH_EMAIL: 'off' } });
    const me = user(t, address('last'));
    identity(t, me, githubAccount(address('last-gh')));
    const { session } = await signedIn(t, me);
    expect(codeOf(await t.oauth.unlinkIdentity(session, { provider: 'github' }))).toBe(
      'AUTH_FORBIDDEN',
    );
    identity(t, me, googleAccount(address('last-g')));
    expect(codeOf(await t.oauth.unlinkIdentity(session, { provider: 'github' }))).toBe('ok');
  });

  it('keeps the unlink when the notice mail fails', async () => {
    const t = setup();
    const email = address('notice-fails');
    const me = user(t, email);
    identity(t, me, googleAccount(email));
    const { session } = await signedIn(t, me);
    const result = await t.oauth.unlinkIdentity(session, { provider: 'google' });
    if (!result.ok) throw result.error;
    t.mail.failNext();
    await result.value.send();
    expect(t.db.tables.identities).toEqual([]);
    expect(t.logs.some((l) => l.event === 'auth.identity_notice_failed')).toBe(true);
  });
});

describe('provider tokens', () => {
  it('are never stored, sent to the database or logged', async () => {
    const t = setup();
    await roundTrip(t, githubAccount(address('tok-gh')));
    await roundTrip(t, googleAccount(address('tok-g')));
    const existing = address('tok-link');
    user(t, existing);
    const pending = await roundTrip(t, githubAccount(existing));
    if (pending.done.ok && pending.done.value.kind === 'link_pending')
      await pending.done.value.send();
    expect(t.fakes.issued.length).toBeGreaterThanOrEqual(5);
    const everything = `${t.db.sent()}${JSON.stringify(t.db.tables)}${JSON.stringify(t.logs)}${JSON.stringify(t.mail.calls)}`;
    for (const issued of t.fakes.issued) expect(everything).not.toContain(issued);
  });
});

describe('openid-client calls nothing outside the guarded fetch', () => {
  it('runs a full GitHub and Google flow with the global fetch throwing', async () => {
    const thrower = vi.fn(() => {
      throw new Error('global fetch must not be called');
    });
    vi.stubGlobal('fetch', thrower);
    const t = setup();
    expect(codeOf((await roundTrip(t, githubAccount(address('nofetch-gh')))).done)).toBe('ok');
    expect(codeOf((await roundTrip(t, googleAccount(address('nofetch-g')))).done)).toBe('ok');
    expect(t.fakes.jwksFetches).toBe(1);
    expect(thrower).not.toHaveBeenCalled();
  });
});

describe('what refusals log', () => {
  it('logs the provider and outcome only', async () => {
    const t = setup();
    const email = address('quiet');
    const { done, query } = await roundTrip(t, githubAccount(email), {
      edit: (q) => {
        q.delete('state');
      },
    });
    expect(codeOf(done)).toBe('AUTH_OAUTH_STATE_INVALID');
    expect(t.logs).toContainEqual({
      level: 'info',
      event: 'auth.oauth_refused',
      fields: { provider: 'github', outcome: 'AUTH_OAUTH_STATE_INVALID' },
    });
    const text = JSON.stringify(t.logs);
    expect(text).not.toContain(email);
    expect(text).not.toContain(query.get('code') ?? 'none');
  });
});

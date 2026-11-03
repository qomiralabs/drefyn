import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  createEmailSignIn,
  createOAuth,
  createSessions,
  parseAuthConfig,
  type AuthConfig,
  type AuthLogger,
  type OAuthProvider,
  type OAuthPurpose,
  type SessionInfo,
} from '../../src/index.ts';
import { createTestAuthMailer, type TestAuthMailer } from '../../src/testing.ts';
import {
  createFakeProviders,
  githubAccount,
  googleAccount,
  oauthEnv,
  type FakeAccount,
  type FakeProviders,
  type FakeSettings,
} from '../oauth-fakes.ts';
import { Jar, codeOf } from '../oauth-fixtures.ts';
import { validEnv } from '../support.ts';
import { ROOMY_LIMITS } from './support/email.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';

const fresh = harness();
let h: Harness;

let n = 0;
const address = (label: string) =>
  `${label}${String((n += 1))}-${randomBytes(3).toString('hex')}@example.com`;

const count = (sql: string) => h.sql(`select count(*) from ${sql};`);
const usersWith = (email: string) => count(`app.users where email_normalized = '${email}'`);
const identitiesOf = (email: string) =>
  count(
    `app.identities i join app.users u on u.id = i.user_id where u.email_normalized = '${email}'`,
  );
const sessionsOf = (email: string) =>
  count(
    `app.sessions s join app.users u on u.id = s.user_id where u.email_normalized = '${email}'`,
  );

interface World {
  readonly config: AuthConfig;
  readonly fakes: FakeProviders;
  readonly mail: TestAuthMailer;
  readonly oauth: ReturnType<typeof createOAuth>;
  readonly email: ReturnType<typeof createEmailSignIn>;
  readonly sessions: ReturnType<typeof createSessions>;
  readonly logs: { event: string; fields: unknown }[];
}

function world(env: Readonly<Record<string, string>> = {}, settings: FakeSettings = {}): World {
  const config = parseAuthConfig({
    ...validEnv(randomBytes(32).toString('base64url')),
    ...ROOMY_LIMITS,
    ...oauthEnv,
    DREFYN_AUTH_RATE_OAUTH_START: '1000/10m',
    DREFYN_AUTH_SIGNUP: 'open',
    ...env,
  });
  const logs: { event: string; fields: unknown }[] = [];
  const logger: AuthLogger = {
    info(event, fields) {
      logs.push({ event, fields });
    },
    warn(event, fields) {
      logs.push({ event, fields });
    },
  };
  const fakes = createFakeProviders(settings);
  const mail = createTestAuthMailer();
  const sessions = createSessions(config, {
    db: h.db,
    authDb: h.authDb,
    logger,
    mailer: mail.mailer,
  });
  const oauth = createOAuth(config, {
    db: h.db,
    authDb: h.authDb,
    logger,
    mailer: mail.mailer,
    sessions,
    oauthTransport: fakes.transport,
  });
  const email = createEmailSignIn(config, {
    db: h.db,
    authDb: h.authDb,
    logger,
    mailer: mail.mailer,
    sessions,
  });
  return { config, fakes, mail, oauth, email, sessions, logs };
}

async function trip(
  w: World,
  account: FakeAccount,
  options: {
    readonly jar?: Jar;
    readonly purpose?: OAuthPurpose;
    readonly session?: SessionInfo;
    readonly callbackProvider?: OAuthProvider;
    readonly edit?: (query: URLSearchParams, jar: Jar) => Promise<void> | void;
  } = {},
) {
  const jar = options.jar ?? new Jar();
  const started = await w.oauth.startOAuth(jar.context(), {
    provider: account.provider,
    purpose: options.purpose ?? 'sign_in',
    ...(options.session === undefined ? {} : { session: options.session }),
  });
  if (!started.ok) throw started.error;
  jar.apply(started.value.setCookies);
  const { query, asked } = w.fakes.approve(started.value.redirectTo, account);
  await options.edit?.(query, jar);
  const done = await w.oauth.completeOAuth(jar.context(), {
    provider: options.callbackProvider ?? account.provider,
    query,
  });
  if (done.ok) jar.apply(done.value.setCookies);
  return { jar, done, query, asked, url: started.value.redirectTo };
}

async function signedInAs(w: World, email: string) {
  const user = await h.user(email);
  const jar = new Jar();
  const started = await w.sessions.startSession(jar.context(), { userId: user, method: 'email' });
  jar.apply(started.setCookies);
  return { user, jar, session: started.session };
}

async function nothingFor(email: string) {
  expect(await usersWith(email)).toBe('0');
  expect(await identitiesOf(email)).toBe('0');
  expect(await sessionsOf(email)).toBe('0');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describeWithStack('OAuth sign in against Postgres and the fake providers', () => {
  beforeAll(async () => {
    h = await fresh();
  });

  it('signs a new GitHub person in once, keyed by the numeric id', async () => {
    const w = world();
    const email = address('new');
    const { done } = await trip(w, githubAccount(email, { id: 9_001, login: 'octo-new' }));
    if (!done.ok) throw done.error;
    expect(done.value.kind).toBe('signed_in');
    expect(
      await h.sql(
        `select provider || ':' || provider_subject from app.identities i join app.users u on u.id = i.user_id where u.email_normalized = '${email}';`,
      ),
    ).toBe('github:9001');
    expect(await sessionsOf(email)).toBe('1');
    expect(
      await count(
        `app.known_devices d join app.users u on u.id = d.user_id where u.email_normalized = '${email}'`,
      ),
    ).toBe('1');
    expect(await count('app.oauth_states')).toBe('0');
  });

  it('refuses a missing state', async () => {
    const w = world();
    const email = address('nostate');
    const { done } = await trip(w, githubAccount(email), {
      edit: (q) => {
        q.delete('state');
      },
    });
    expect(codeOf(done)).toBe('AUTH_OAUTH_STATE_INVALID');
    await nothingFor(email);
  });

  it('refuses a state that does not match the cookie', async () => {
    const w = world();
    const email = address('cookie');
    const { done } = await trip(w, githubAccount(email), {
      edit: (_q, jar) => {
        jar.cookies.set(w.config.cookies.oauth, 'a'.repeat(52));
      },
    });
    expect(codeOf(done)).toBe('AUTH_OAUTH_STATE_INVALID');
    await nothingFor(email);
  });

  it('refuses a state started for the other provider', async () => {
    const w = world();
    const email = address('provider');
    const { done } = await trip(w, githubAccount(email), { callbackProvider: 'google' });
    expect(codeOf(done)).toBe('AUTH_OAUTH_STATE_INVALID');
    await nothingFor(email);
  });

  it('refuses a replayed state, with one winner', async () => {
    const w = world();
    const email = address('replay');
    const first = await trip(w, githubAccount(email));
    expect(codeOf(first.done)).toBe('ok');
    first.jar.cookies.set(w.config.cookies.oauth, first.query.get('state') ?? '');
    const again = await w.oauth.completeOAuth(first.jar.context(), {
      provider: 'github',
      query: first.query,
    });
    expect(codeOf(again)).toBe('AUTH_OAUTH_STATE_INVALID');
    expect(await sessionsOf(email)).toBe('1');
  });

  it('gives two concurrent callbacks with one state exactly one winner', async () => {
    const w = world();
    const email = address('race');
    const jar = new Jar();
    const started = await w.oauth.startOAuth(jar.context(), {
      provider: 'github',
      purpose: 'sign_in',
    });
    if (!started.ok) throw started.error;
    jar.apply(started.value.setCookies);
    const { query } = w.fakes.approve(started.value.redirectTo, githubAccount(email));
    const results = await Promise.all([
      w.oauth.completeOAuth(jar.context(), { provider: 'github', query }),
      w.oauth.completeOAuth(jar.context(), { provider: 'github', query }),
    ]);
    expect(results.map(codeOf).sort()).toEqual(['AUTH_OAUTH_STATE_INVALID', 'ok']);
  });

  it('refuses an expired state', async () => {
    const w = world();
    const email = address('expired');
    const { done } = await trip(w, githubAccount(email), {
      edit: async () => {
        await h.sql(`update app.oauth_states set expires_at = now() - interval '1 second';`);
      },
    });
    expect(codeOf(done)).toBe('AUTH_OAUTH_STATE_INVALID');
    await nothingFor(email);
  });

  it('refuses a missing PKCE verifier', async () => {
    const w = world({}, { dropVerifier: true });
    const email = address('noverifier');
    const { done } = await trip(w, githubAccount(email));
    expect(codeOf(done)).toBe('AUTH_OAUTH_PROVIDER_ERROR');
    await nothingFor(email);
  });

  it('refuses a wrong PKCE verifier', async () => {
    const w = world();
    const email = address('wrongverifier');
    const { done } = await trip(w, githubAccount(email), {
      edit: async () => {
        await h.sql(`update app.oauth_states set code_verifier = '${'z'.repeat(52)}';`);
      },
    });
    expect(codeOf(done)).toBe('AUTH_OAUTH_PROVIDER_ERROR');
    await nothingFor(email);
  });

  it('refuses a bad nonce', async () => {
    const w = world({}, { nonce: 'other' });
    const email = address('nonce');
    const { done } = await trip(w, googleAccount(email));
    expect(codeOf(done)).toBe('AUTH_OAUTH_PROVIDER_ERROR');
    await nothingFor(email);
  });

  it('refuses an unverified email', async () => {
    const w = world();
    const email = address('unverified');
    const { done } = await trip(w, githubAccount(email, { verified: false }));
    expect(codeOf(done)).toBe('AUTH_OAUTH_EMAIL_UNVERIFIED');
    await nothingFor(email);
  });

  it('never links a matching address without the email code, and the code names the account', async () => {
    const w = world();
    const email = address('existing');
    await h.user(email);
    const account = githubAccount(email, { id: 31_337, login: 'mona-int' });
    const { done, jar } = await trip(w, account);
    if (!done.ok) throw done.error;
    expect(done.value.kind).toBe('link_pending');
    expect(await identitiesOf(email)).toBe('0');
    expect(await sessionsOf(email)).toBe('0');
    if (done.value.kind !== 'link_pending') return;
    await done.value.send();
    const mail = w.mail.sent.find((m) => m.to === email);
    expect(mail?.purpose).toBe('link_identity');
    expect(mail?.linking).toEqual({ provider: 'github', account: 'mona-int' });
    expect(
      await h.sql(
        `select pending_provider || ':' || pending_subject from app.email_challenges where email_normalized = '${email}' and purpose = 'link_identity';`,
      ),
    ).toBe('github:31337');
    const [challenge = '', code = ''] = (mail?.link.hash.slice(1) ?? '').split('.');
    const verified = await w.email.verifyLinkCode(jar.context(), null, { challenge, code });
    if (!verified.ok) throw verified.error;
    expect(verified.value.kind === 'signed_in' && verified.value.signedIn.session.method).toBe(
      'github',
    );
    expect(await identitiesOf(email)).toBe('1');
    if (verified.value.kind === 'signed_in') await verified.value.signedIn.send?.();
    // This browser never signed in to the account before, so the link also counts as a
    // sign in from a new device.
    expect(w.mail.notices.filter((x) => x.to === email).map((x) => x.notice.kind)).toEqual([
      'identity_linked',
      'new_device_sign_in',
    ]);
  });

  it('refuses step up with an identity not linked to the session user', async () => {
    const w = world();
    const me = await signedInAs(w, address('me'));
    const them = address('them');
    const theirs = googleAccount(them);
    // Their identity exists, linked to them.
    const signedUp = await trip(w, theirs);
    expect(codeOf(signedUp.done)).toBe('ok');
    const { done } = await trip(w, theirs, {
      jar: me.jar,
      purpose: 'step_up',
      session: me.session,
    });
    expect(codeOf(done)).toBe('AUTH_STEP_UP_IDENTITY_MISMATCH');
    expect(
      await h.sql(
        `select coalesce(step_up_method, '-') from app.sessions where id = '${me.session.sessionId}';`,
      ),
    ).toBe('-');
  });

  it('Google step up sends prompt=login and max_age=0 and refuses an old auth_time', async () => {
    const email = address('gstep');
    const w = world({}, { authTimeAgoSeconds: 10 });
    const linked = await trip(w, googleAccount(email, { sub: `g-${email}` }));
    expect(codeOf(linked.done)).toBe('ok');
    const session =
      linked.done.ok && linked.done.value.kind === 'signed_in' ? linked.done.value.session : null;
    if (session === null) throw new Error('no session');
    const fresh = await trip(w, googleAccount(email, { sub: `g-${email}` }), {
      jar: linked.jar,
      purpose: 'step_up',
      session,
    });
    expect(fresh.asked.get('prompt')).toBe('login');
    expect(fresh.asked.get('max_age')).toBe('0');
    expect(fresh.done.ok && fresh.done.value.kind).toBe('stepped_up');
    expect(
      await h.sql(`select step_up_method from app.sessions where id = '${session.sessionId}';`),
    ).toBe('google');
    w.fakes.set({ authTimeAgoSeconds: 360 });
    const old = await trip(w, googleAccount(email, { sub: `g-${email}` }), {
      jar: linked.jar,
      purpose: 'step_up',
      session,
    });
    expect(codeOf(old.done)).toBe('AUTH_RECENT_AUTH_REQUIRED');
  });

  it('GitHub step up is refused when another method exists, and is github_session otherwise', async () => {
    const withEmail = world();
    const a = address('gh-a');
    const first = await trip(withEmail, githubAccount(a, { id: 70_001 }));
    const s1 =
      first.done.ok && first.done.value.kind === 'signed_in' ? first.done.value.session : null;
    if (s1 === null) throw new Error('no session');
    // Email is on by default, so GitHub step up is refused before the round trip.
    const refused = await withEmail.oauth.startOAuth(first.jar.context(), {
      provider: 'github',
      purpose: 'step_up',
      session: s1,
    });
    expect(codeOf(refused)).toBe('AUTH_FORBIDDEN');

    const emailOff = world({ DREFYN_AUTH_EMAIL: 'off' });
    const b = address('gh-b');
    const second = await trip(emailOff, githubAccount(b, { id: 70_002 }));
    const s2 =
      second.done.ok && second.done.value.kind === 'signed_in' ? second.done.value.session : null;
    if (s2 === null) throw new Error('no session');
    const allowed = await trip(emailOff, githubAccount(b, { id: 70_002 }), {
      jar: second.jar,
      purpose: 'step_up',
      session: s2,
    });
    expect(
      allowed.done.ok &&
        allowed.done.value.kind === 'stepped_up' &&
        allowed.done.value.session.stepUpMethod,
    ).toBe('github_session');
    expect(
      await h.sql(`select step_up_method from app.sessions where id = '${s2.sessionId}';`),
    ).toBe('github_session');
  });

  it('stores no provider token in any table and logs none', async () => {
    const w = world();
    await trip(w, githubAccount(address('tok-gh')));
    await trip(w, googleAccount(address('tok-g')));
    const dump = await h.sql(
      `select string_agg(to_jsonb(t)::text, ' ') from (select * from app.identities) t;`,
    );
    const states = await h.sql(
      `select coalesce(string_agg(to_jsonb(t)::text, ' '), '') from app.oauth_states t;`,
    );
    const challenges = await h.sql(
      `select coalesce(string_agg(to_jsonb(t)::text, ' '), '') from app.email_challenges t;`,
    );
    const sessions = await h.sql(
      `select coalesce(string_agg(to_jsonb(t)::text, ' '), '') from app.sessions t;`,
    );
    const logs = JSON.stringify(w.logs);
    expect(w.fakes.issued.length).toBeGreaterThanOrEqual(4);
    for (const issued of w.fakes.issued) {
      for (const text of [dump, states, challenges, sessions, logs])
        expect(text).not.toContain(issued);
    }
  });

  it('runs GitHub and Google with the global fetch throwing: openid-client uses only the guarded fetch', async () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('global fetch must not be called');
    });
    const w = world();
    expect(codeOf((await trip(w, githubAccount(address('nofetch-gh')))).done)).toBe('ok');
    expect(codeOf((await trip(w, googleAccount(address('nofetch-g')))).done)).toBe('ok');
    expect(w.fakes.jwksFetches).toBe(1);
  });

  it('checks Google signatures through the JWKS, fetched at most once across two sign ins', async () => {
    const w = world();
    expect(codeOf((await trip(w, googleAccount(address('jwks-1')))).done)).toBe('ok');
    expect(codeOf((await trip(w, googleAccount(address('jwks-2')))).done)).toBe('ok');
    expect(w.fakes.jwksFetches).toBe(1);
    for (const signature of ['flipped', 'foreign'] as const) {
      const bad = world({}, { signature });
      const email = address(`sig-${signature}`);
      expect(codeOf((await trip(bad, googleAccount(email))).done)).toBe(
        'AUTH_OAUTH_PROVIDER_ERROR',
      );
      await nothingFor(email);
    }
  });

  it('answers a JWKS outage with a provider error and writes no user, identity or session', async () => {
    const w = world({}, { jwks: 'down' });
    const email = address('jwks-down');
    expect(codeOf((await trip(w, googleAccount(email))).done)).toBe('AUTH_OAUTH_PROVIDER_ERROR');
    await nothingFor(email);
  });

  it('maps GitHub token errors sent as HTTP 200', async () => {
    for (const [error, expected] of [
      ['bad_verification_code', 'AUTH_OAUTH_STATE_INVALID'],
      ['expired_token', 'AUTH_OAUTH_STATE_INVALID'],
      ['incorrect_client_credentials', 'AUTH_OAUTH_PROVIDER_ERROR'],
      ['redirect_uri_mismatch', 'AUTH_OAUTH_PROVIDER_ERROR'],
      ['application_suspended', 'AUTH_OAUTH_PROVIDER_ERROR'],
    ] as const) {
      const w = world({}, { githubTokenError: error });
      const email = address('gherr');
      expect(codeOf((await trip(w, githubAccount(email))).done), error).toBe(expected);
      await nothingFor(email);
      const logged = w.logs.filter((l) => l.event === 'auth.oauth_misconfigured');
      expect(logged, error).toEqual(
        expected === 'AUTH_OAUTH_PROVIDER_ERROR'
          ? [{ event: 'auth.oauth_misconfigured', fields: { provider: 'github', error } }]
          : [],
      );
    }
  });

  it('builds redirect_uri from the app origin, never from forged request headers', async () => {
    const w = world();
    for (const provider of ['github', 'google'] as const) {
      const forged = {
        ...new Jar().context(),
        headers: {
          host: 'evil.example',
          'x-forwarded-host': 'evil.example',
          'x-forwarded-proto': 'http',
        },
      };
      const started = await w.oauth.startOAuth(forged, { provider, purpose: 'sign_in' });
      if (!started.ok) throw started.error;
      expect(started.value.redirectTo.searchParams.get('redirect_uri')).toBe(
        `${w.config.appOrigin}/auth/oauth/${provider}/callback`,
      );
    }
  });

  it('sends a security notice on link and unlink', async () => {
    const w = world();
    const email = address('notice');
    const me = await signedInAs(w, email);
    const linked = await trip(w, githubAccount(address('notice-gh')), {
      jar: me.jar,
      purpose: 'link',
      session: me.session,
    });
    if (!linked.done.ok || linked.done.value.kind !== 'linked') throw new Error('expected linked');
    await linked.done.value.send();
    const unlinked = await w.oauth.unlinkIdentity(me.session, { provider: 'github' });
    if (!unlinked.ok) throw unlinked.error;
    await unlinked.value.send();
    expect(w.mail.notices.filter((x) => x.to === email).map((x) => x.notice.kind)).toEqual([
      'identity_linked',
      'identity_unlinked',
    ]);
    expect(await identitiesOf(email)).toBe('0');
  });
});

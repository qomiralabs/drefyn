import { createHash, createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  EGRESS_LEDGER_URL,
  egressProblems,
  routedFetch,
  unblockedHosts,
} from '../e2e/oauth-egress.ts';
import {
  createFakeProvider,
  encodeScript,
  FAKE_CLIENTS,
  FAKE_ORIGIN,
  fakeUrl,
  isAuthorizationUrl,
  OAUTH_ORIGIN,
  PROVIDER_HOSTS,
  type FakeProvider,
  type FakeScript,
  type ProviderName,
} from '../e2e/oauth-fake.ts';

const VERIFIER = 'a-verifier-long-enough-for-the-fake-to-hash';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const ACCOUNT = { subject: '4242', email: 'a@example.dev', verified: true };
const DOORS = {
  github: '/github.com/login/oauth/authorize',
  google: '/accounts.google.com/o/oauth2/v2/auth',
} as const;
const DECIDE = { github: '/github.com/fake/decide', google: '/accounts.google.com/fake/decide' };
const TOKEN = {
  github: '/github.com/login/oauth/access_token',
  google: '/oauth2.googleapis.com/token',
} as const;

const get = (fake: FakeProvider, url: string, authorization?: string) =>
  fake.answer({ method: 'GET', url, authorization, body: '' });

function askFor(provider: ProviderName, script?: FakeScript, change: object = {}) {
  const query = new URLSearchParams({
    client_id: FAKE_CLIENTS[provider].id,
    redirect_uri: `${OAUTH_ORIGIN}/auth/oauth/${provider}/callback`,
    state: 'the-state',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    ...(provider === 'google' ? { nonce: 'the-nonce' } : {}),
    fake_script: encodeScript(script ?? { account: ACCOUNT }),
    ...change,
  });
  return `${DOORS[provider]}?${query.toString()}`;
}

function visit(fake: FakeProvider, provider: ProviderName, script?: FakeScript, answer = 'allow') {
  const page = get(fake, askFor(provider, script));
  expect(page.status).toBe(200);
  const ticket = /ticket=([0-9a-f]+)/.exec(page.body)?.[1] ?? '';
  const moved = get(fake, `${DECIDE[provider]}?ticket=${ticket}&answer=${answer}`);
  expect(moved.status).toBe(302);
  return new URL(moved.headers['location'] ?? '');
}

function redeem(fake: FakeProvider, provider: ProviderName, code: string, change: object = {}) {
  const body = new URLSearchParams({
    client_id: FAKE_CLIENTS[provider].id,
    client_secret: FAKE_CLIENTS[provider].secret,
    code,
    redirect_uri: `${OAUTH_ORIGIN}/auth/oauth/${provider}/callback`,
    code_verifier: VERIFIER,
    ...change,
  });
  return fake.answer({ method: 'POST', url: TOKEN[provider], body: body.toString() });
}

const bodyOf = <T = unknown>(answer: { readonly body: string }): T => JSON.parse(answer.body) as T;

describe('the fake provider', () => {
  it.each(['github', 'google'] as const)('%s asks a person, then returns a code', (provider) => {
    const back = visit(createFakeProvider(), provider);
    expect(back.origin + back.pathname).toBe(`${OAUTH_ORIGIN}/auth/oauth/${provider}/callback`);
    expect(back.searchParams.get('state')).toBe('the-state');
    expect(back.searchParams.get('code')).toMatch(/^[0-9a-f]{20}$/);
  });

  it.each([
    ['a wrong client', { client_id: 'other' }],
    ['a callback on another origin', { redirect_uri: 'https://evil.test/cb' }],
    ['no state', { state: '' }],
    ['no challenge', { code_challenge: '' }],
    ['a plain challenge', { code_challenge_method: 'plain' }],
  ])('refuses %s', (_name, change) => {
    expect(get(createFakeProvider(), askFor('github', undefined, change)).status).toBe(400);
  });

  it('refuses Google without a nonce', () => {
    expect(get(createFakeProvider(), askFor('google', undefined, { nonce: '' })).status).toBe(400);
  });

  it('reports a denial as access_denied, with the state and no code', () => {
    const back = visit(createFakeProvider(), 'github', undefined, 'deny');
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe('the-state');
    expect(back.searchParams.has('code')).toBe(false);
  });

  it('can send a wrong state or an error, per visit', () => {
    const fake = createFakeProvider();
    const wrong = visit(fake, 'google', { account: ACCOUNT, callback: 'wrong_state' });
    expect(wrong.searchParams.get('state')).not.toBe('the-state');
    const failed = visit(fake, 'google', { account: ACCOUNT, callback: 'server_error' });
    expect(failed.searchParams.get('error')).toBe('server_error');
  });

  it('spends a GitHub code once, answering the second with a 200, as GitHub does', () => {
    const fake = createFakeProvider();
    const code = visit(fake, 'github').searchParams.get('code') ?? '';
    expect(bodyOf(redeem(fake, 'github', code))).toMatchObject({ token_type: 'bearer' });
    const again = redeem(fake, 'github', code);
    expect(again.status).toBe(200);
    expect(bodyOf(again)).toMatchObject({ error: 'bad_verification_code' });
  });

  it('spends a Google code once, answering the second with invalid_grant', () => {
    const fake = createFakeProvider();
    const code = visit(fake, 'google').searchParams.get('code') ?? '';
    expect(redeem(fake, 'google', code).status).toBe(200);
    const again = redeem(fake, 'google', code);
    expect(again.status).toBe(400);
    expect(bodyOf(again)).toMatchObject({ error: 'invalid_grant' });
  });

  it('holds a replayed code to the first use, even on a new visit', () => {
    const fake = createFakeProvider();
    const code = visit(fake, 'github').searchParams.get('code') ?? '';
    redeem(fake, 'github', code);
    const back = visit(fake, 'github', { account: ACCOUNT, code });
    expect(back.searchParams.get('code')).toBe(code);
    expect(bodyOf(redeem(fake, 'github', code))).toMatchObject({ error: 'bad_verification_code' });
  });

  it.each([
    ['a wrong verifier', { code_verifier: 'wrong' }, 'invalid_grant'],
    ['a wrong secret', { client_secret: 'wrong' }, 'incorrect_client_credentials'],
    ['another callback', { redirect_uri: 'https://evil.test/cb' }, 'redirect_uri_mismatch'],
  ])('refuses a GitHub token request with %s', (_name, change, error) => {
    const fake = createFakeProvider();
    const code = visit(fake, 'github').searchParams.get('code') ?? '';
    expect(bodyOf(redeem(fake, 'github', code, change))).toMatchObject({ error });
  });

  it('answers 503 when the script takes the token endpoint down', () => {
    const fake = createFakeProvider();
    const back = visit(fake, 'google', { account: ACCOUNT, tokenEndpoint: 'down' });
    expect(redeem(fake, 'google', back.searchParams.get('code') ?? '').status).toBe(503);
  });

  it('serves GitHub profiles only to the token it issued', () => {
    const fake = createFakeProvider();
    const secondary = { email: 'b@example.dev', verified: true };
    const back = visit(fake, 'github', { account: { ...ACCOUNT, verified: false, secondary } });
    const access = fieldOf(
      redeem(fake, 'github', back.searchParams.get('code') ?? ''),
      'access_token',
    );
    expect(get(fake, '/api.github.com/user').status).toBe(401);
    expect(bodyOf(get(fake, '/api.github.com/user', `Bearer ${access}`))).toMatchObject({
      id: 4242,
    });
    expect(bodyOf(get(fake, '/api.github.com/user/emails', `Bearer ${access}`))).toEqual([
      { email: ACCOUNT.email, primary: true, verified: false },
      { email: secondary.email, primary: false, verified: true },
    ]);
  });

  it('signs a Google ID token the published key verifies, with the asked nonce', () => {
    const fake = createFakeProvider();
    const code = visit(fake, 'google').searchParams.get('code') ?? '';
    const token = fieldOf(redeem(fake, 'google', code), 'id_token');
    const [header = '', payload = '', signature = ''] = token.split('.');
    const { keys } = bodyOf<{ keys: [JsonWebKey] }>(
      get(fake, '/www.googleapis.com/oauth2/v3/certs'),
    );
    const key = createPublicKey({ key: keys[0], format: 'jwk' });
    const signed = Buffer.from(`${header}.${payload}`);
    expect(verify('sha256', signed, key, Buffer.from(signature, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toMatchObject({
      iss: 'https://accounts.google.com',
      aud: FAKE_CLIENTS.google.id,
      nonce: 'the-nonce',
      sub: ACCOUNT.subject,
      email_verified: true,
    });
  });

  it('logs what it saw, for the spec that proves the stack came here', () => {
    const fake = createFakeProvider();
    get(fake, '/api.github.com/user');
    expect(fake.log).toEqual(['GET api.github.com/user']);
    expect(bodyOf(get(fake, '/__log'))).toContain('GET api.github.com/user');
  });

  it('answers anything else with a 404', () => {
    expect(get(createFakeProvider(), '/github.com/login').status).toBe(404);
  });
});

describe('the provider URLs', () => {
  it('knows the two pages a browser is sent to, by exact path', () => {
    expect(isAuthorizationUrl(new URL('https://github.com/login/oauth/authorize?a=1'))).toBe(true);
    expect(isAuthorizationUrl(new URL('https://accounts.google.com/o/oauth2/v2/auth'))).toBe(true);
    expect(isAuthorizationUrl(new URL('https://github.com/login/oauth/authorize/x'))).toBe(false);
    expect(isAuthorizationUrl(new URL('https://evil.test/login/oauth/authorize'))).toBe(false);
  });

  it('maps a provider URL under the fake, query included', () => {
    expect(fakeUrl(new URL('https://api.github.com/user/emails?a=1'))).toBe(
      `${FAKE_ORIGIN}/api.github.com/user/emails?a=1`,
    );
  });
});

describe('routedFetch', () => {
  const setUp = () => {
    const calls: unknown[] = [];
    const strays: string[] = [];
    const real = ((input: unknown) => {
      calls.push(input);
      return Promise.resolve(new Response('ok'));
    }) as typeof fetch;
    return { calls, strays, fetch: routedFetch(real, (host) => strays.push(host)) };
  };

  it.each(PROVIDER_HOSTS)('sends %s to the fake', async (host) => {
    const { calls, fetch, strays } = setUp();
    await fetch(`https://${host}/some/path?q=1`);
    expect(calls).toEqual([`${FAKE_ORIGIN}/${host}/some/path?q=1`]);
    expect(strays).toEqual([]);
  });

  it.each(['http://127.0.0.1:3100/x', 'http://localhost:3100/x', 'http://[::1]:3100/x'])(
    'leaves loopback alone: %s',
    async (url) => {
      const { calls, fetch } = setUp();
      await fetch(url);
      expect(calls).toEqual([url]);
    },
  );

  it.each([
    'https://api.pwnedpasswords.com/range/ABCDE',
    'https://github.com.evil.test/login',
    'https://evil.test/github.com',
    'https://user:pass@example.org/',
  ])('refuses and notes anything else: %s', async (url) => {
    const { calls, fetch, strays } = setUp();
    await expect(fetch(url)).rejects.toThrow('fetch failed');
    expect(calls).toEqual([]);
    expect(strays).toHaveLength(1);
  });

  it('reads the URL of a Request too', async () => {
    const { calls, fetch } = setUp();
    await fetch(new Request('https://oauth2.googleapis.com/token', { method: 'POST' }));
    expect(calls).toEqual([`${FAKE_ORIGIN}/oauth2.googleapis.com/token`]);
  });

  it('reads the URL of a URL too', async () => {
    const { calls, fetch } = setUp();
    await fetch(new URL('https://github.com/x'));
    expect(calls).toEqual([`${FAKE_ORIGIN}/github.com/x`]);
  });
});

describe('the egress check', () => {
  const hostsFile = (hosts: readonly string[]) =>
    ['# comment', '127.0.0.1 localhost', ...hosts.map((host) => `127.0.0.1\t${host}`)].join('\n');

  it('passes when every provider host is loopback and the ledger is empty', () => {
    expect(egressProblems(hostsFile(PROVIDER_HOSTS), '')).toEqual([]);
  });

  it('names a provider host that still resolves', () => {
    const [first = '', ...rest] = PROVIDER_HOSTS;
    expect(unblockedHosts(hostsFile(rest))).toEqual([first]);
    expect(egressProblems(hostsFile(rest), '')).toEqual([
      `${first} is not blocked in this container`,
    ]);
  });

  it('does not count a host pointed anywhere but loopback', () => {
    expect(unblockedHosts(`10.0.0.1 github.com\n${hostsFile(PROVIDER_HOSTS.slice(1))}`)).toEqual([
      PROVIDER_HOSTS[0],
    ]);
  });

  it('names every stray in the ledger', () => {
    expect(egressProblems(hostsFile(PROVIDER_HOSTS), 'evil.test\nexample.org\n')).toEqual([
      'a server tried to reach evil.test',
      'a server tried to reach example.org',
    ]);
  });

  it('keeps the ledger out of the repository, beside the seeded cookies', () => {
    expect(EGRESS_LEDGER_URL.pathname.endsWith('/e2e/.auth/egress.log')).toBe(true);
  });
});

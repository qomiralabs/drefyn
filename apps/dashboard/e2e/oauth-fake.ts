import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

// GitHub and Google as the ADR spike measured them, for a real browser and a real build. The
// answers live here, free of sockets, so a unit test can walk them; oauth-fake-server.ts
// puts them on loopback. Paths start with the provider's host, which is how one server
// stands in for all of them.

// A server of its own, because client ids put provider buttons on the sign in page and the
// baselines of the other servers have none.
export const OAUTH_PORT = 3105;
export const OAUTH_ORIGIN = `http://127.0.0.1:${String(OAUTH_PORT)}`;
export const FAKE_PORT = 3106;
export const FAKE_ORIGIN = `http://127.0.0.1:${String(FAKE_PORT)}`;

export type ProviderName = 'github' | 'google';

export const FAKE_CLIENTS = {
  github: { id: 'fake-github-client', secret: 'fake-github-secret' },
  google: { id: 'fake-google-client', secret: 'fake-google-secret' },
} as const;

export const FAKE_CLIENT_ENV = {
  DREFYN_AUTH_GITHUB_CLIENT_ID: FAKE_CLIENTS.github.id,
  DREFYN_AUTH_GITHUB_CLIENT_SECRET: FAKE_CLIENTS.github.secret,
  DREFYN_AUTH_GOOGLE_CLIENT_ID: FAKE_CLIENTS.google.id,
  DREFYN_AUTH_GOOGLE_CLIENT_SECRET: FAKE_CLIENTS.google.secret,
} as const;

// What the dashboard server calls, and the two pages a browser is sent to.
export const SERVER_HOSTS = [
  'github.com',
  'api.github.com',
  'oauth2.googleapis.com',
  'www.googleapis.com',
] as const;
export const BROWSER_HOSTS = ['github.com', 'accounts.google.com'] as const;
export const PROVIDER_HOSTS: readonly string[] = [...new Set([...SERVER_HOSTS, ...BROWSER_HOSTS])];

const DOORS: Readonly<Record<string, ProviderName>> = {
  'github.com/login/oauth/authorize': 'github',
  'accounts.google.com/o/oauth2/v2/auth': 'google',
};
const ISSUERS: Readonly<Record<ProviderName, string>> = {
  github: 'https://github.com/login/oauth',
  google: 'https://accounts.google.com',
};
const LABELS: Readonly<Record<ProviderName, string>> = { github: 'GitHub', google: 'Google' };

export const isAuthorizationUrl = (url: URL): boolean =>
  Object.hasOwn(DOORS, `${url.host}${url.pathname}`);

// Where a request for a provider's own URL goes in the stack.
export const fakeUrl = (url: URL): string =>
  `${FAKE_ORIGIN}/${url.host}${url.pathname}${url.search}`;

export interface FakeAccount {
  // GitHub's numeric id as digits, or Google's sub.
  readonly subject: string;
  readonly email: string;
  readonly verified: boolean;
  // A second address on the GitHub account, never the primary.
  readonly secondary?: { readonly email: string; readonly verified: boolean };
}

// One person's visit to the provider. How it goes wrong is chosen here, per visit, so two
// tests never share a setting on the server.
export interface FakeScript {
  readonly account: FakeAccount;
  readonly callback?: 'as_asked' | 'wrong_state' | 'server_error';
  readonly tokenEndpoint?: 'up' | 'down';
  // Sends this code back instead of a new one, as a replay would.
  readonly code?: string;
  // How long ago the person signed in at Google, for a step up. It is what auth_time reports.
  readonly authTimeAgoSeconds?: number;
}

export const encodeScript = (script: FakeScript): string =>
  Buffer.from(JSON.stringify(script)).toString('base64url');

const decodeScript = (value: string): FakeScript =>
  JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as FakeScript;

export interface FakeRequest {
  readonly method: string;
  // Path and query, with the provider's host as the first segment.
  readonly url: string;
  readonly authorization?: string | undefined;
  readonly body: string;
}

export interface FakeAnswer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

interface Visit {
  readonly provider: ProviderName;
  readonly script: FakeScript;
  readonly redirectUri: string;
  readonly state: string;
  readonly challenge: string;
  readonly nonce: string | null;
  // Google adds auth_time only when asked with max_age, which step up does.
  readonly maxAge: string | null;
}

interface Grant {
  readonly visit: Visit;
  used: boolean;
}

export interface FakeProvider {
  answer(request: FakeRequest): FakeAnswer;
  // Every request seen, as method, host and path, so a spec can prove the stack came here.
  readonly log: readonly string[];
}

const json = (status: number, body: unknown): FakeAnswer => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(body),
});
const NOT_FOUND = json(404, { error: 'not_found' });

const moved = (location: string): FakeAnswer => ({ status: 302, headers: { location }, body: '' });

const b64url = (bytes: Uint8Array | string) => Buffer.from(bytes).toString('base64url');
const s256 = (verifier: string) => b64url(createHash('sha256').update(verifier).digest());
const token = (prefix: string) => `${prefix}${randomBytes(24).toString('base64url')}`;

function consentPage(provider: ProviderName, ticket: string): FakeAnswer {
  const decide = (answer: string) => `/fake/decide?ticket=${ticket}&amp;answer=${answer}`;
  return {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: `<!doctype html><title>Fake ${LABELS[provider]}</title><h1>Fake ${LABELS[provider]}</h1><a href="${decide('allow')}">Authorize</a> <a href="${decide('deny')}">Cancel</a>`,
  };
}

export function createFakeProvider(redirectOrigin: string = OAUTH_ORIGIN): FakeProvider {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomBytes(8).toString('hex');
  const visits = new Map<string, Visit>();
  const grants = new Map<string, Grant>();
  const bearers = new Map<string, FakeAccount>();
  const log: string[] = [];

  function idToken(visit: Visit): string {
    const { account } = visit.script;
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
    const payload = b64url(
      JSON.stringify({
        iss: ISSUERS.google,
        azp: FAKE_CLIENTS.google.id,
        aud: FAKE_CLIENTS.google.id,
        sub: account.subject,
        email: account.email,
        email_verified: account.verified,
        nonce: visit.nonce,
        ...(visit.maxAge === null
          ? {}
          : { auth_time: now - (visit.script.authTimeAgoSeconds ?? 1) }),
        iat: now,
        exp: now + 3599,
      }),
    );
    const signature = sign('sha256', Buffer.from(`${header}.${payload}`), privateKey);
    return `${header}.${payload}.${b64url(signature)}`;
  }

  // Refuses what either provider would: an unknown client, a callback it was not told
  // about, or no PKCE. The product always sends them, so a 400 here is a product bug.
  function authorize(provider: ProviderName, query: URLSearchParams): FakeAnswer {
    const redirectUri = query.get('redirect_uri') ?? '';
    const state = query.get('state') ?? '';
    const challenge = query.get('code_challenge') ?? '';
    const nonce = query.get('nonce');
    const script = query.get('fake_script');
    const allowed = `${redirectOrigin}/auth/oauth/${provider}/callback`;
    if (
      query.get('client_id') !== FAKE_CLIENTS[provider].id ||
      redirectUri !== allowed ||
      state === '' ||
      challenge === '' ||
      query.get('code_challenge_method') !== 'S256' ||
      (provider === 'google' && !nonce) ||
      script === null
    ) {
      return json(400, { error: 'invalid_request' });
    }
    const ticket = randomBytes(12).toString('hex');
    visits.set(ticket, {
      provider,
      script: decodeScript(script),
      redirectUri,
      state,
      challenge,
      nonce,
      maxAge: query.get('max_age'),
    });
    return consentPage(provider, ticket);
  }

  // What the provider sends the browser back with. Google adds more than this; auth reads
  // only code, state and iss.
  function decide(query: URLSearchParams): FakeAnswer {
    const visit = visits.get(query.get('ticket') ?? '');
    if (visit === undefined) return json(400, { error: 'invalid_request' });
    const back = new URL(visit.redirectUri);
    const { callback = 'as_asked', code } = visit.script;
    back.searchParams.set('iss', ISSUERS[visit.provider]);
    back.searchParams.set('state', callback === 'wrong_state' ? token('wrong') : visit.state);
    if (query.get('answer') !== 'allow') {
      back.searchParams.set('error', 'access_denied');
    } else if (callback === 'server_error') {
      back.searchParams.set('error', 'server_error');
    } else {
      const issued = code ?? randomBytes(10).toString('hex');
      if (code === undefined) grants.set(issued, { visit, used: false });
      back.searchParams.set('code', issued);
    }
    return moved(back.href);
  }

  // A code is spent by any attempt, right or wrong, as GitHub does.
  function redeem(form: URLSearchParams, provider: ProviderName): Grant | null {
    const grant = grants.get(form.get('code') ?? '');
    if (grant === undefined || grant.used || grant.visit.provider !== provider) return null;
    grant.used = true;
    return grant;
  }

  function issueToken(provider: ProviderName, form: URLSearchParams): FakeAnswer {
    const client = FAKE_CLIENTS[provider];
    const github = provider === 'github';
    // GitHub answers errors with 200, as the spike measured; the guarded fetch turns those
    // back into 400s, so this path is part of what the browser tests prove.
    const error = (code: string, status: number) =>
      json(github ? 200 : status, { error: code, error_description: `fake ${code}` });
    if (form.get('client_id') !== client.id || form.get('client_secret') !== client.secret) {
      return error(github ? 'incorrect_client_credentials' : 'invalid_client', 401);
    }
    const grant = redeem(form, provider);
    if (grant === null) return error(github ? 'bad_verification_code' : 'invalid_grant', 400);
    if (grant.visit.script.tokenEndpoint === 'down') return json(503, { error: 'unavailable' });
    if (form.get('redirect_uri') !== grant.visit.redirectUri) {
      return error('redirect_uri_mismatch', 400);
    }
    if (s256(form.get('code_verifier') ?? '') !== grant.visit.challenge) {
      return json(400, { error: 'invalid_grant', error_description: 'fake pkce' });
    }
    const access = token(github ? 'gho_' : 'ya29.');
    if (github) {
      bearers.set(access, grant.visit.script.account);
      return json(200, {
        access_token: access,
        token_type: 'bearer',
        scope: 'read:user,user:email',
      });
    }
    return json(200, {
      access_token: access,
      expires_in: 3599,
      scope: 'openid https://www.googleapis.com/auth/userinfo.email',
      token_type: 'Bearer',
      id_token: idToken(grant.visit),
    });
  }

  function githubApi(path: string, authorization: string | undefined): FakeAnswer {
    const account = bearers.get(/^Bearer (\S+)$/.exec(authorization ?? '')?.[1] ?? '');
    if (account === undefined) return json(401, { message: 'Bad credentials' });
    if (path === '/user') {
      // The email here can be typed in by the person, so auth must never read it.
      return json(200, {
        id: Number(account.subject),
        login: `octo${account.subject}`,
        email: 'set.by.the.person@example.org',
      });
    }
    const primary = { email: account.email, primary: true, verified: account.verified };
    const secondary =
      account.secondary === undefined ? [] : [{ ...account.secondary, primary: false }];
    return json(200, [primary, ...secondary]);
  }

  const jwks = () => {
    const key = publicKey.export({ format: 'jwk' });
    return json(200, { keys: [{ ...key, kid, alg: 'RS256', use: 'sig' }] });
  };

  return {
    answer(request) {
      const url = new URL(request.url, 'http://fake.invalid');
      log.push(`${request.method} ${url.pathname.slice(1)}`);
      const form = new URLSearchParams(request.body);
      const door = DOORS[url.pathname.slice(1)];
      if (door !== undefined && request.method === 'GET') return authorize(door, url.searchParams);
      switch (`${request.method} ${url.pathname}`) {
        case 'GET /__health':
          return json(200, { ok: true });
        case 'GET /__log':
          return json(200, log);
        case 'GET /github.com/fake/decide':
        case 'GET /accounts.google.com/fake/decide':
          return decide(url.searchParams);
        case 'POST /github.com/login/oauth/access_token':
          return issueToken('github', form);
        case 'POST /oauth2.googleapis.com/token':
          return issueToken('google', form);
        case 'GET /api.github.com/user':
          return githubApi('/user', request.authorization);
        case 'GET /api.github.com/user/emails':
          return githubApi('/user/emails', request.authorization);
        case 'GET /www.googleapis.com/oauth2/v3/certs':
          return jwks();
        default:
          return NOT_FOUND;
      }
    },
    get log() {
      return [...log];
    },
  };
}

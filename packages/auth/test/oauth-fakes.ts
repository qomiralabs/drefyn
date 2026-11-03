import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

// GitHub and Google as the spike measured them, answered in process: no socket, so no test
// can reach a real provider and none needs an egress exception. The transport is what
// auth's guarded fetch hands a request to after its own host, scheme and size checks.

export const GITHUB_CLIENT = { id: 'fake-github-client', secret: 'fake-github-secret' } as const;
export const GOOGLE_CLIENT = { id: 'fake-google-client', secret: 'fake-google-secret' } as const;

export const oauthEnv = {
  DREFYN_AUTH_GITHUB_CLIENT_ID: GITHUB_CLIENT.id,
  DREFYN_AUTH_GITHUB_CLIENT_SECRET: GITHUB_CLIENT.secret,
  DREFYN_AUTH_GOOGLE_CLIENT_ID: GOOGLE_CLIENT.id,
  DREFYN_AUTH_GOOGLE_CLIENT_SECRET: GOOGLE_CLIENT.secret,
} as const;

export interface GitHubEmail {
  readonly email: string;
  readonly primary: boolean;
  readonly verified: boolean;
  readonly visibility: 'public' | 'private' | null;
}

export interface GitHubAccount {
  readonly provider: 'github';
  readonly id: number;
  readonly login: string;
  readonly emails: readonly GitHubEmail[];
}

export interface GoogleAccount {
  readonly provider: 'google';
  readonly sub: string;
  readonly email: string;
  readonly emailVerified: boolean;
}

export type FakeAccount = GitHubAccount | GoogleAccount;

// The real sample had one primary verified address, a verified noreply one that is not
// primary and an unverified one; visibility is null except on the primary.
export function githubAccount(
  email: string,
  options: { readonly id?: number; readonly login?: string; readonly verified?: boolean } = {},
): GitHubAccount {
  const id = options.id ?? 40_000_000 + Math.floor(Math.random() * 1_000_000);
  const login = options.login ?? `octo${String(id)}`;
  return {
    provider: 'github',
    id,
    login,
    emails: [
      { email, primary: true, verified: options.verified ?? true, visibility: 'private' },
      {
        email: `${String(id)}+${login}@users.noreply.github.com`,
        primary: false,
        verified: true,
        visibility: null,
      },
      { email: `old.${email}`, primary: false, verified: false, visibility: null },
    ],
  };
}

export function googleAccount(
  email: string,
  options: { readonly sub?: string; readonly verified?: boolean } = {},
): GoogleAccount {
  return {
    provider: 'google',
    sub:
      options.sub ?? String(100_000_000_000_000_000_000n + BigInt(Math.floor(Math.random() * 1e9))),
    email,
    emailVerified: options.verified ?? true,
  };
}

export interface FakeSettings {
  // Answered by the GitHub token endpoint with HTTP 200, as GitHub does.
  githubTokenError?: string;
  jwks?: 'up' | 'down';
  // The ID token's nonce: the requested one, another one, or none at all.
  nonce?: 'requested' | 'other' | 'absent';
  signature?: 'valid' | 'flipped' | 'foreign';
  // How long ago the person signed in at Google, for auth_time.
  authTimeAgoSeconds?: number;
  // Strips code_verifier from token requests before the fake reads them.
  dropVerifier?: boolean;
}

interface Grant {
  readonly provider: 'github' | 'google';
  readonly account: FakeAccount;
  readonly redirectUri: string;
  readonly challenge: string | null;
  readonly nonce: string | null;
  readonly maxAge: string | null;
  used: boolean;
}

export interface Approval {
  // The callback query the provider sends the browser back with.
  readonly query: URLSearchParams;
  // What the authorization request asked for, as the provider saw it.
  readonly asked: URLSearchParams;
}

export type Transport = (url: string, init: RequestInit) => Promise<Response>;

export interface FakeProviders {
  readonly transport: Transport;
  // Plays the person at the provider: reads the authorization URL auth built, signs in
  // as the account and returns the callback query.
  approve(authorizationUrl: URL, account: FakeAccount): Approval;
  // A code minted for another authorization, as an attacker would inject one.
  mintCode(account: FakeAccount, redirectUri: string, challenge: string | null): string;
  set(settings: FakeSettings): void;
  // Every request that reached the fake, as method and URL.
  readonly requests: readonly string[];
  // Every token string issued: access, refresh and ID tokens.
  readonly issued: readonly string[];
  readonly jwksFetches: number;
}

const GITHUB_ISSUER = 'https://github.com/login/oauth';
const GOOGLE_ISSUER = 'https://accounts.google.com';
const DOCS =
  'https://docs.github.com/apps/managing-oauth-apps/troubleshooting-oauth-app-access-token-request-errors';

const b64url = (bytes: Uint8Array | string) => Buffer.from(bytes).toString('base64url');
const s256 = (verifier: string) => b64url(createHash('sha256').update(verifier).digest());
const token = (prefix: string) => `${prefix}${randomBytes(24).toString('base64url')}`;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function formOf(body: RequestInit['body']): URLSearchParams {
  if (body instanceof URLSearchParams) return new URLSearchParams(body);
  if (typeof body === 'string') return new URLSearchParams(body);
  return new URLSearchParams();
}

function keyPair(): { privateKey: KeyObject; jwk: Record<string, unknown> } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  return { privateKey, jwk };
}

export function createFakeProviders(initial: FakeSettings = {}): FakeProviders {
  let settings: FakeSettings = { ...initial };
  const grants = new Map<string, Grant>();
  const tokens = new Map<string, FakeAccount>();
  const requests: string[] = [];
  const issued: string[] = [];
  let jwksFetches = 0;
  // Made on first use: RSA keys take a while, and most GitHub tests never need one.
  let keys:
    { signing: ReturnType<typeof keyPair>; foreign: ReturnType<typeof keyPair> } | undefined;
  const keysNow = () => (keys ??= { signing: keyPair(), foreign: keyPair() });
  const kid = randomBytes(8).toString('hex');

  function idToken(grant: Grant, account: GoogleAccount): string {
    const now = Math.floor(Date.now() / 1000);
    const nonce =
      settings.nonce === 'absent'
        ? {}
        : { nonce: settings.nonce === 'other' ? token('n') : (grant.nonce ?? undefined) };
    const authTime =
      grant.maxAge === null ? {} : { auth_time: now - (settings.authTimeAgoSeconds ?? 1) };
    const header = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
    const payload = b64url(
      JSON.stringify({
        iss: GOOGLE_ISSUER,
        azp: GOOGLE_CLIENT.id,
        aud: GOOGLE_CLIENT.id,
        sub: account.sub,
        email: account.email,
        email_verified: account.emailVerified,
        ...nonce,
        ...authTime,
        iat: now,
        exp: now + 3599,
      }),
    );
    const key =
      settings.signature === 'foreign'
        ? keysNow().foreign.privateKey
        : keysNow().signing.privateKey;
    const signature = sign('sha256', Buffer.from(`${header}.${payload}`), key);
    if (settings.signature === 'flipped') signature[10] = (signature[10] ?? 0) ^ 0x01;
    return `${header}.${payload}.${b64url(signature)}`;
  }

  // The grant the code names, burned by any attempt, right or wrong, as GitHub does.
  function redeem(form: URLSearchParams, provider: 'github' | 'google'): Grant | null {
    const grant = grants.get(form.get('code') ?? '');
    if (grant === undefined || grant.used || grant.provider !== provider) return null;
    grant.used = true;
    return grant;
  }

  function pkceFailure(grant: Grant, form: URLSearchParams): string | null {
    if (grant.challenge === null) return null;
    const verifier = form.get('code_verifier');
    if (verifier === null) {
      return 'Codes requested with a code_challenge MUST be redeemed with a code_verifier';
    }
    return s256(verifier) === grant.challenge
      ? null
      : 'The code_verifier did not match the code_challenge';
  }

  function githubToken(form: URLSearchParams): Response {
    const error = (code: string) =>
      json(200, { error: code, error_description: `fake ${code}`, error_uri: DOCS });
    if (
      form.get('client_id') !== GITHUB_CLIENT.id ||
      form.get('client_secret') !== GITHUB_CLIENT.secret
    ) {
      return error('incorrect_client_credentials');
    }
    if (settings.githubTokenError !== undefined) return error(settings.githubTokenError);
    const grant = redeem(form, 'github');
    if (grant === null) return error('bad_verification_code');
    if (form.get('redirect_uri') !== grant.redirectUri) return error('redirect_uri_mismatch');
    const pkce = pkceFailure(grant, form);
    if (pkce !== null) return json(400, { error: 'invalid_grant', error_description: pkce });
    const access = token('gho_');
    const refresh = token('ghr_');
    issued.push(access, refresh);
    tokens.set(access, grant.account);
    return json(200, {
      access_token: access,
      expires_in: 28_800,
      refresh_token: refresh,
      refresh_token_expires_in: 15_897_600,
      token_type: 'bearer',
      scope: 'read:user,user:email',
    });
  }

  function googleToken(form: URLSearchParams): Response {
    if (
      form.get('client_id') !== GOOGLE_CLIENT.id ||
      form.get('client_secret') !== GOOGLE_CLIENT.secret
    ) {
      return json(401, { error: 'invalid_client', error_description: 'Unauthorized' });
    }
    const grant = redeem(form, 'google');
    if (grant === null)
      return json(400, { error: 'invalid_grant', error_description: 'Bad Request' });
    if (form.get('redirect_uri') !== grant.redirectUri) {
      return json(400, { error: 'redirect_uri_mismatch', error_description: 'Bad Request' });
    }
    const pkce = pkceFailure(grant, form);
    if (pkce !== null) return json(400, { error: 'invalid_grant', error_description: pkce });
    const account = grant.account;
    if (account.provider !== 'google') throw new Error('fake: a GitHub grant at Google');
    const access = token('ya29.');
    const id = idToken(grant, account);
    issued.push(access, id);
    return json(200, {
      access_token: access,
      expires_in: 3599,
      scope: 'openid https://www.googleapis.com/auth/userinfo.email',
      token_type: 'Bearer',
      id_token: id,
    });
  }

  function githubApi(path: string, headers: Headers): Response {
    const bearer = /^Bearer (\S+)$/.exec(headers.get('authorization') ?? '')?.[1] ?? '';
    const account = tokens.get(bearer);
    if (account?.provider !== 'github') {
      return json(401, { message: 'Bad credentials', status: '401' });
    }
    if (path === '/user') {
      return json(200, {
        login: account.login,
        id: account.id,
        node_id: `U_${String(account.id)}`,
        type: 'User',
        name: null,
        // Can be filled in by the person, so auth never reads it.
        email: 'set.by.the.person@example.org',
      });
    }
    if (path === '/user/emails') return json(200, account.emails);
    return json(404, { message: 'Not Found' });
  }

  const transport: Transport = (url, init) => {
    const target = new URL(url);
    const method = (init.method ?? 'GET').toUpperCase();
    requests.push(`${method} ${target.origin}${target.pathname}`);
    const form = formOf(init.body);
    if (settings.dropVerifier === true) form.delete('code_verifier');
    const headers = new Headers(init.headers);
    const key = `${method} ${target.host}${target.pathname}`;
    switch (key) {
      case 'POST github.com/login/oauth/access_token':
        return Promise.resolve(githubToken(form));
      case 'GET api.github.com/user':
      case 'GET api.github.com/user/emails':
        return Promise.resolve(githubApi(target.pathname, headers));
      case 'POST oauth2.googleapis.com/token':
        return Promise.resolve(googleToken(form));
      case 'GET www.googleapis.com/oauth2/v3/certs':
        jwksFetches += 1;
        if (settings.jwks === 'down') {
          return Promise.resolve(new Response('unavailable', { status: 503 }));
        }
        return Promise.resolve(
          json(200, { keys: [{ ...keysNow().signing.jwk, kid, alg: 'RS256', use: 'sig' }] }),
        );
      default:
        return Promise.resolve(json(404, { error: 'not_found' }));
    }
  };

  function mint(account: FakeAccount, asked: URLSearchParams): string {
    const code =
      account.provider === 'github' ? randomBytes(10).toString('hex') : `4/0${token('')}`;
    grants.set(code, {
      provider: account.provider,
      account,
      redirectUri: asked.get('redirect_uri') ?? '',
      challenge: asked.get('code_challenge_method') === 'S256' ? asked.get('code_challenge') : null,
      nonce: asked.get('nonce'),
      maxAge: asked.get('max_age'),
      used: false,
    });
    return code;
  }

  return {
    transport,
    approve(authorizationUrl, account) {
      const asked = authorizationUrl.searchParams;
      const github = account.provider === 'github';
      const expected = github
        ? 'https://github.com/login/oauth/authorize'
        : 'https://accounts.google.com/o/oauth2/v2/auth';
      if (`${authorizationUrl.origin}${authorizationUrl.pathname}` !== expected) {
        throw new Error('fake: authorization URL is not this provider');
      }
      const client = github ? GITHUB_CLIENT.id : GOOGLE_CLIENT.id;
      if (asked.get('client_id') !== client) throw new Error('fake: unknown client_id');
      const query = new URLSearchParams({ code: mint(account, asked) });
      query.set('state', asked.get('state') ?? '');
      if (github) query.set('iss', GITHUB_ISSUER);
      else {
        query.set('scope', 'email openid https://www.googleapis.com/auth/userinfo.email');
        query.set('authuser', '0');
        query.set('prompt', 'none');
        query.set('iss', GOOGLE_ISSUER);
      }
      return { query, asked: new URLSearchParams(asked) };
    },
    mintCode(account, redirectUri, challenge) {
      const asked = new URLSearchParams({ redirect_uri: redirectUri });
      if (challenge !== null) {
        asked.set('code_challenge', challenge);
        asked.set('code_challenge_method', 'S256');
      }
      return mint(account, asked);
    },
    set(next) {
      settings = { ...settings, ...next };
    },
    get requests() {
      return [...requests];
    },
    get issued() {
      return [...issued];
    },
    get jwksFetches() {
      return jwksFetches;
    },
  };
}

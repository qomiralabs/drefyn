import type { Database } from '@drefyn/db';
import { describe, expect, it } from 'vitest';
import {
  AuthError,
  apiKeyErrorResponse,
  checkApiKeyScope,
  createApiKeyFailureLimiter,
  createApiKeyVerifier,
  parseApiAuthConfig,
  redact,
  type ApiKeyActor,
  type ApiKeyFailureLimiter,
} from '../src/index.ts';
import {
  API_ENV,
  KEY,
  ORG,
  PROJECT_A,
  PROJECT_B,
  bearer,
  countingLimiter,
  keyFor,
  keyRow,
  verifierFor,
  verifyResponder,
} from './api-key-fixtures.ts';
import { scriptedStore } from './scripted-store.ts';
import { capturingLogger } from './session-fixtures.ts';
import { base64url, expectAuthError } from './support.ts';

const IP = '203.0.113.7';

describe('verifyApiKey header rules', () => {
  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['the key with no scheme', keyFor()],
    ['lower case bearer', `bearer ${keyFor()}`],
    ['basic', `Basic ${keyFor()}`],
    ['two spaces', `Bearer  ${keyFor()}`],
    ['a trailing space', `Bearer ${keyFor()} `],
    ['two keys', `Bearer ${keyFor()},${keyFor()}`],
    ['a session cookie value', 'Bearer v1.abc'],
    ['an upper case key', `Bearer ${keyFor().toUpperCase()}`],
  ])('refuses %s without opening a transaction, and counts it', async (_name, header) => {
    const { verifier, scripted, limiter } = verifierFor(verifyResponder([keyRow()]));
    const result = await verifier.verifyApiKey(header, IP);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AUTH_API_KEY_INVALID');
    expect(scripted.events).toEqual([]);
    expect(limiter.keys).toEqual(['ip4:203.0.113.7']);
  });

  it('counts an IPv6 client by its /64', async () => {
    const { verifier, limiter } = verifierFor(verifyResponder([]));
    await verifier.verifyApiKey(undefined, '2001:db8:1:2:3:4:5:6');
    expect(limiter.keys).toEqual(['ip6:2001:0db8:0001:0002::/64']);
  });
});

describe('the failure limiter', () => {
  it('answers AUTH_RATE_LIMITED with the retry once the limiter refuses', async () => {
    const limiter: ApiKeyFailureLimiter = {
      reserve: () => Promise.reject(new AuthError('AUTH_RATE_LIMITED', { retryAfterSeconds: 42 })),
    };
    const { verifier } = verifierFor(verifyResponder([]), limiter);
    const result = await verifier.verifyApiKey(bearer(), IP);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('AUTH_RATE_LIMITED');
      expect(result.error.retryAfterSeconds).toBe(42);
    }
  });

  it('fails closed with AUTH_UNAVAILABLE when the limiter cannot count', async () => {
    const limiter: ApiKeyFailureLimiter = {
      reserve: () => Promise.reject(new AuthError('AUTH_UNAVAILABLE')),
    };
    const { verifier } = verifierFor(verifyResponder([]), limiter);
    const result = await verifier.verifyApiKey(bearer(), IP);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.code).toBe('AUTH_UNAVAILABLE');
  });

  it('refuses the key when the limiter gets a row it cannot trust', async () => {
    const limiter = createApiKeyFailureLimiter({
      db: {} as Database,
      config: parseApiAuthConfig(API_ENV),
      reserve: (_db, request) =>
        Promise.resolve(
          request.windowSeconds.map((windowSeconds) => ({
            windowSeconds,
            count: 999,
            retryAfterSeconds: 0,
          })),
        ),
    });
    const { verifier } = verifierFor(verifyResponder([]), limiter);
    const result = await verifier.verifyApiKey(bearer(), IP);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.code).toBe('AUTH_UNAVAILABLE');
  });

  it('refuses a client address that is not one', async () => {
    const { verifier } = verifierFor(verifyResponder([]));
    const result = await verifier.verifyApiKey(bearer(), 'not an ip');
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.code).toBe('AUTH_INPUT_INVALID');
  });
});

describe('verifyApiRequest', () => {
  it('verifies the header when the query has no key', async () => {
    const { verifier } = verifierFor(verifyResponder([keyRow()]));
    const result = await verifier.verifyApiRequest({
      authorization: bearer(),
      url: 'https://api.drefyn.test/v1/docs?page=2',
      ip: IP,
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    ['as a value', (k: string) => `?api_key=${k}`],
    ['as a name', (k: string) => `?${k}`],
    ['percent encoded', (k: string) => `?key=${encodeURIComponent(k).replace(/_/g, '%5F')}`],
    ['upper case', (k: string) => `?key=${k.toUpperCase()}`],
    ['in a later parameter', (k: string) => `?a=1&token=${k}`],
  ])(
    'refuses a key in the query string %s, even beside a good header, and never logs it',
    async (_name, query) => {
      const { verifier, scripted, lines, limiter } = verifierFor(verifyResponder([keyRow()]));
      const key = keyFor();
      const url = `https://api.drefyn.test/v1/docs${query(key)}`;
      for (const target of [url, new URL(url)]) {
        const result = await verifier.verifyApiRequest({
          authorization: bearer(),
          url: target,
          ip: IP,
        });
        if (result.ok) throw new Error('expected a refusal');
        expect(result.error.code).toBe('AUTH_API_KEY_INVALID');
        expect(JSON.stringify(result.error)).not.toContain(key.slice(-20));
        expect(result.error.message).not.toContain(key.slice(-20));
      }
      expect(scripted.events).toEqual([]);
      expect(limiter.keys).toHaveLength(2);
      expect(JSON.stringify(lines)).not.toContain(key.slice(-20));
      expect(JSON.stringify(lines).toLowerCase()).not.toContain('drf_ak_');
    },
  );

  it('refuses a URL that does not parse', async () => {
    const { verifier } = verifierFor(verifyResponder([keyRow()]));
    const result = await verifier.verifyApiRequest({
      authorization: bearer(),
      url: 'not a url',
      ip: IP,
    });
    expect(result.ok).toBe(false);
  });

  it('is redacted by redact() wherever a URL or header holding a key is logged', () => {
    const key = keyFor();
    const fields = redact({
      url: `https://api.drefyn.test/v1?k=${key}`,
      authorization: bearer(key),
    });
    expect(JSON.stringify(fields)).not.toContain(key.slice(-20));
  });
});

describe('logging', () => {
  it('logs nothing for refused keys, so a flood cannot fill the log', async () => {
    const { verifier, lines } = verifierFor(
      verifyResponder([keyRow({ secret: Buffer.alloc(32, 1) })]),
    );
    for (let i = 0; i < 5; i += 1) await verifier.verifyApiKey(bearer(), IP);
    expect(lines).toEqual([]);
  });

  it('logs a database failure by the claimed ids, never the key', async () => {
    const scripted = scriptedStore(() => {
      throw new Error('connection lost');
    });
    const { logger, lines } = capturingLogger();
    const limiter = countingLimiter();
    const verifier = createApiKeyVerifier(API_ENV, { store: scripted.store, limiter, logger });
    const result = await verifier.verifyApiKey(bearer(), IP);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.code).toBe('AUTH_UNAVAILABLE');
    expect(limiter.keys).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.event).toBe('auth.api_key_verify_failed');
    expect(Object.keys(lines[0]?.fields ?? {})).toEqual(['claimedOrganizationId', 'keyId']);
    expect(JSON.stringify(lines)).not.toContain(keyFor().slice(-20));
  });
});

describe('createApiKeyVerifier at startup', () => {
  it.each([
    'DREFYN_AUTH_DATABASE_URL',
    'DREFYN_AUTH_SECRET',
    'DREFYN_AUTH_SECRET_PREVIOUS',
    'DREFYN_AUTH_GITHUB_CLIENT_SECRET',
  ])('refuses to start with %s set, naming the key and never the value', (key) => {
    const value = 'postgres://drefyn_auth:hunter2@db/drefyn';
    const error = expectAuthError(
      () =>
        createApiKeyVerifier(
          { ...API_ENV, [key]: value },
          { db: {} as Database, logger: capturingLogger().logger },
        ),
      'AUTH_CONFIG_INVALID',
      key as never,
    );
    expect(error.message).not.toContain('hunter2');
  });

  it('refuses to start without its own failure key, or with a short one', () => {
    const logger = capturingLogger().logger;
    expectAuthError(
      () => createApiKeyVerifier({}, { db: {} as Database, logger }),
      'AUTH_CONFIG_INVALID',
      'DREFYN_API_RATE_LIMIT_KEY',
    );
    expectAuthError(
      () =>
        createApiKeyVerifier(
          { DREFYN_API_RATE_LIMIT_KEY: base64url(new Uint8Array(8)) },
          { db: {} as Database, logger },
        ),
      'AUTH_CONFIG_INVALID',
    );
  });

  it('refuses to start with neither a database nor a store and limiter', () => {
    const logger = capturingLogger().logger;
    expectAuthError(() => createApiKeyVerifier(API_ENV, { logger }), 'AUTH_CONFIG_INVALID');
    expectAuthError(
      () => createApiKeyVerifier(API_ENV, { logger, store: scriptedStore().store }),
      'AUTH_CONFIG_INVALID',
    );
    expect(() => createApiKeyVerifier(API_ENV, { logger, db: {} as Database })).not.toThrow();
  });
});

describe('checkApiKeyScope', () => {
  const actor = (projectIds: ApiKeyActor['projectIds']): ApiKeyActor => ({
    kind: 'api_key',
    keyId: KEY,
    organizationId: ORG,
    scopes: ['docs:read'],
    projectIds,
  });

  it('allows a held scope on a reached project', () => {
    expect(checkApiKeyScope(actor('all'), 'docs:read', PROJECT_A)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(checkApiKeyScope(actor([PROJECT_A]), 'docs:read', PROJECT_A).ok).toBe(true);
    expect(checkApiKeyScope(actor([]), 'docs:read').ok).toBe(true);
  });

  it('refuses a missing scope or an unreached project with AUTH_API_KEY_SCOPE', () => {
    for (const [a, scope, project] of [
      [actor('all'), 'docs:publish', PROJECT_A],
      [actor([PROJECT_A]), 'docs:read', PROJECT_B],
      [actor([]), 'docs:read', PROJECT_A],
    ] as const) {
      const result = checkApiKeyScope(a, scope, project);
      if (result.ok) throw new Error('expected a refusal');
      expect(result.error.code).toBe('AUTH_API_KEY_SCOPE');
    }
  });
});

describe('apiKeyErrorResponse', () => {
  const body = (code: string) => JSON.stringify({ error: { code } });

  it('maps each refusal to the public contract', () => {
    expect(apiKeyErrorResponse(new AuthError('AUTH_API_KEY_INVALID'))).toEqual({
      status: 401,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: body('auth.api_key_invalid'),
    });
    expect(apiKeyErrorResponse(new AuthError('AUTH_API_KEY_SCOPE'))).toMatchObject({
      status: 403,
      body: body('auth.api_key_scope'),
    });
    expect(
      apiKeyErrorResponse(new AuthError('AUTH_RATE_LIMITED', { retryAfterSeconds: 37 })),
    ).toEqual({
      status: 429,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'retry-after': '37',
      },
      body: body('auth.rate_limited'),
    });
    expect(apiKeyErrorResponse(new AuthError('AUTH_UNAVAILABLE'))).toMatchObject({
      status: 503,
      body: body('auth.unavailable'),
    });
  });

  it('answers every other code as an invalid key, so the body says nothing more', () => {
    for (const code of ['AUTH_INPUT_INVALID', 'AUTH_FORBIDDEN', 'AUTH_NOT_FOUND'] as const) {
      expect(apiKeyErrorResponse(new AuthError(code))).toMatchObject({
        status: 401,
        body: body('auth.api_key_invalid'),
      });
    }
  });

  it('gives a rate limit with no retry at least one second', () => {
    expect(apiKeyErrorResponse(new AuthError('AUTH_RATE_LIMITED')).headers['retry-after']).toBe(
      '1',
    );
  });
});

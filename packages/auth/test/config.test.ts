import { inspect } from 'node:util';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AUTH_CONFIG_KEYS,
  RATE_BUCKETS,
  parseApiAuthConfig,
  parseAuthConfig,
  type AuthConfigKey,
} from '../src/index.ts';
import { base64url, caught, expectAuthError, runs, validEnv } from './support.ts';

type Env = Record<string, string | undefined>;

const SECRET = base64url(new Uint8Array(32).fill(7));
const OTHER = base64url(new Uint8Array(32).fill(9));

const env = (patch: Env = {}): Env => ({ ...validEnv(SECRET), ...patch });

function refuses(patch: Env, key: AuthConfigKey) {
  return expectAuthError(() => parseAuthConfig(env(patch)), 'AUTH_CONFIG_INVALID', key);
}

describe('parseAuthConfig defaults', () => {
  it('reads a minimal environment with every default from the config table', () => {
    const config = parseAuthConfig(env());
    expect(config.appOrigin).toBe('https://app.drefyn.test');
    expect(config.signUp).toBe('invite_only');
    expect(config.email).toBe('auto');
    expect(config.oauth).toEqual({ github: null, google: null });
    expect(config.session).toEqual({ absoluteDays: 30, idleDays: 7 });
    expect(config.cookieSecure).toBe(true);
    expect(config.cookies).toEqual({
      session: '__Host-drefyn_session',
      pre: '__Host-drefyn_pre',
      oauth: '__Host-drefyn_oauth',
      invite: '__Host-drefyn_invite',
    });
    expect(config.trustedProxyHops).toBe(0);
    expect(config.clientIpHeader).toBeNull();
    expect(config.threadPoolSize).toBe(16);
    expect(config.passwords).toEqual({
      enabled: true,
      argon2: { memoryKib: 19456, passes: 2, parallelism: 1 },
      hashConcurrency: 4,
      hashQueueMax: 64,
      breachedPasswordsFile: null,
    });
    expect(config.rateLimits).toEqual({
      email_send: [
        { count: 3, windowSeconds: 600 },
        { count: 10, windowSeconds: 86_400 },
      ],
      email_send_address_ceiling: [{ count: 30, windowSeconds: 86_400 }],
      email_send_ip: [{ count: 20, windowSeconds: 600 }],
      code_verify: [{ count: 10, windowSeconds: 3600 }],
      oauth_start: [{ count: 30, windowSeconds: 600 }],
      org_create: [{ count: 3, windowSeconds: 86_400 }],
      invite_send_user: [{ count: 50, windowSeconds: 3600 }],
      invite_recipient: [{ count: 5, windowSeconds: 86_400 }],
      invite_send: [{ count: 50, windowSeconds: 3600 }],
      password_fail: [{ count: 10, windowSeconds: 900 }],
      password_fail_ip: [{ count: 30, windowSeconds: 600 }],
    });
    expect(Object.keys(config.rateLimits)).toEqual([...RATE_BUCKETS]);
  });

  it('freezes the config all the way down', () => {
    const config = parseAuthConfig(env());
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.session)).toBe(true);
    expect(Object.isFrozen(config.passwords.argon2)).toBe(true);
    expect(Object.isFrozen(config.rateLimits.email_send)).toBe(true);
    expect(Object.isFrozen(config.rateLimits.email_send[0])).toBe(true);
  });

  it('treats an empty value as unset, the way compose passes one', () => {
    const config = parseAuthConfig(
      env({ DREFYN_AUTH_SIGNUP: '', DREFYN_AUTH_SECRET_PREVIOUS: '' }),
    );
    expect(config.signUp).toBe('invite_only');
    expect(config.keys.rotating).toBe(false);
  });

  it('normalises the origin to its serialised form', () => {
    expect(
      parseAuthConfig(env({ DREFYN_APP_ORIGIN: 'https://APP.Drefyn.test:443' })).appOrigin,
    ).toBe('https://app.drefyn.test');
    expect(parseAuthConfig(env({ DREFYN_APP_ORIGIN: 'https://app.drefyn.test/' })).appOrigin).toBe(
      'https://app.drefyn.test',
    );
  });

  it('reads every key when set to a valid value', () => {
    const config = parseAuthConfig(
      env({
        DREFYN_AUTH_SECRET_PREVIOUS: OTHER,
        DREFYN_AUTH_SIGNUP: 'open',
        DREFYN_AUTH_EMAIL: 'off',
        DREFYN_AUTH_GITHUB_CLIENT_ID: 'Iv1.abc123',
        DREFYN_AUTH_GITHUB_CLIENT_SECRET: 'gh-secret-value-0001',
        DREFYN_AUTH_GOOGLE_CLIENT_ID: '123-abc.apps.googleusercontent.com',
        DREFYN_AUTH_GOOGLE_CLIENT_SECRET: 'GOCSPX-google-secret-0001',
        DREFYN_AUTH_SESSION_ABSOLUTE_DAYS: '90',
        DREFYN_AUTH_SESSION_IDLE_DAYS: '30',
        DREFYN_TRUSTED_PROXY_HOPS: '2',
        DREFYN_CLIENT_IP_HEADER: 'cloudfront-viewer-address',
        DREFYN_AUTH_RATE_EMAIL_SEND: '5/15m,20/1d',
        DREFYN_AUTH_PASSWORDS: 'on',
        DREFYN_AUTH_PASSWORD_ARGON2_MEMORY_KIB: '65536',
        DREFYN_AUTH_PASSWORD_ARGON2_PASSES: '3',
        DREFYN_AUTH_PASSWORD_ARGON2_PARALLELISM: '4',
        DREFYN_AUTH_PASSWORD_HASH_CONCURRENCY: '7',
        DREFYN_AUTH_PASSWORD_HASH_QUEUE_MAX: '0',
        DREFYN_AUTH_BREACHED_PASSWORDS_FILE: '/var/lib/drefyn/breached.bin',
        // Owned by @drefyn/db, so auth leaves them alone.
        DREFYN_AUTH_DATABASE_URL: 'postgres://drefyn_auth:pw@postgres:5432/drefyn',
        DREFYN_AUTH_DATABASE_POOL_MAX: '4',
      }),
    );
    expect(config.keys.rotating).toBe(true);
    expect(config.signUp).toBe('open');
    expect(config.email).toBe('off');
    expect(config.oauth.github?.clientId).toBe('Iv1.abc123');
    expect(config.oauth.github?.clientSecret.reveal()).toBe('gh-secret-value-0001');
    expect(config.oauth.google?.clientId).toBe('123-abc.apps.googleusercontent.com');
    expect(config.oauth.google?.clientSecret.reveal()).toBe('GOCSPX-google-secret-0001');
    expect(config.session).toEqual({ absoluteDays: 90, idleDays: 30 });
    expect(config.trustedProxyHops).toBe(2);
    expect(config.clientIpHeader).toBe('cloudfront-viewer-address');
    expect(config.rateLimits.email_send).toEqual([
      { count: 5, windowSeconds: 900 },
      { count: 20, windowSeconds: 86_400 },
    ]);
    expect(config.passwords).toEqual({
      enabled: true,
      argon2: { memoryKib: 65536, passes: 3, parallelism: 4 },
      hashConcurrency: 7,
      hashQueueMax: 0,
      breachedPasswordsFile: '/var/lib/drefyn/breached.bin',
    });
  });

  it('allows plain http only on a loopback origin with secure cookies off, and drops the prefix', () => {
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1', 'http://localhost']) {
      const config = parseAuthConfig(
        env({ DREFYN_APP_ORIGIN: origin, DREFYN_AUTH_COOKIE_SECURE: 'false' }),
      );
      expect(config.cookieSecure).toBe(false);
      expect(config.cookies).toEqual({
        session: 'drefyn_session',
        pre: 'drefyn_pre',
        oauth: 'drefyn_oauth',
        invite: 'drefyn_invite',
      });
    }
  });

  it('skips the thread pool rule when passwords are off, since nothing hashes', () => {
    const config = parseAuthConfig(
      env({ DREFYN_AUTH_PASSWORDS: 'off', UV_THREADPOOL_SIZE: undefined }),
    );
    expect(config.passwords.enabled).toBe(false);
    expect(config.threadPoolSize).toBeNull();
  });
});

describe('parseAuthConfig refuses, naming the key', () => {
  it('a missing, malformed or non origin DREFYN_APP_ORIGIN', () => {
    for (const value of [
      undefined,
      'app.drefyn.test',
      'https://app.drefyn.test/path',
      'https://app.drefyn.test/?x=1',
      'https://app.drefyn.test/#x',
      'https://user:pw@app.drefyn.test',
      'ftp://app.drefyn.test',
      'javascript:alert(1)',
      'https://',
    ]) {
      refuses({ DREFYN_APP_ORIGIN: value }, 'DREFYN_APP_ORIGIN');
    }
  });

  it('a non https origin with secure cookies', () => {
    refuses({ DREFYN_APP_ORIGIN: 'http://app.drefyn.test' }, 'DREFYN_APP_ORIGIN');
    refuses({ DREFYN_APP_ORIGIN: 'http://localhost:3000' }, 'DREFYN_APP_ORIGIN');
  });

  it('secure cookies off anywhere but an http loopback origin, and a value that is not a boolean', () => {
    refuses({ DREFYN_AUTH_COOKIE_SECURE: 'false' }, 'DREFYN_AUTH_COOKIE_SECURE');
    refuses(
      { DREFYN_APP_ORIGIN: 'http://localhost.evil.test', DREFYN_AUTH_COOKIE_SECURE: 'false' },
      'DREFYN_AUTH_COOKIE_SECURE',
    );
    refuses(
      { DREFYN_APP_ORIGIN: 'http://127.0.0.2', DREFYN_AUTH_COOKIE_SECURE: 'false' },
      'DREFYN_AUTH_COOKIE_SECURE',
    );
    refuses(
      { DREFYN_APP_ORIGIN: 'https://localhost', DREFYN_AUTH_COOKIE_SECURE: 'false' },
      'DREFYN_AUTH_COOKIE_SECURE',
    );
    for (const value of ['yes', 'False', '0', 'off']) {
      refuses({ DREFYN_AUTH_COOKIE_SECURE: value }, 'DREFYN_AUTH_COOKIE_SECURE');
    }
  });

  it('a missing, short, padded, non canonical or non base64url secret', () => {
    refuses({ DREFYN_AUTH_SECRET: undefined }, 'DREFYN_AUTH_SECRET');
    refuses({ DREFYN_AUTH_SECRET: base64url(new Uint8Array(31).fill(1)) }, 'DREFYN_AUTH_SECRET');
    refuses({ DREFYN_AUTH_SECRET: `${SECRET}=` }, 'DREFYN_AUTH_SECRET');
    refuses({ DREFYN_AUTH_SECRET: `${SECRET.slice(0, -1)}+` }, 'DREFYN_AUTH_SECRET');
    refuses({ DREFYN_AUTH_SECRET: ` ${SECRET}` }, 'DREFYN_AUTH_SECRET');
    // 43 symbols carry 258 bits; the last two must be zero in the one canonical form.
    refuses({ DREFYN_AUTH_SECRET: `${SECRET.slice(0, -1)}B` }, 'DREFYN_AUTH_SECRET');
    refuses({ DREFYN_AUTH_SECRET: 'A'.repeat(4097) }, 'DREFYN_AUTH_SECRET');
  });

  it('a short previous secret, and one equal to the current secret', () => {
    refuses(
      { DREFYN_AUTH_SECRET_PREVIOUS: base64url(new Uint8Array(16)) },
      'DREFYN_AUTH_SECRET_PREVIOUS',
    );
    refuses({ DREFYN_AUTH_SECRET_PREVIOUS: SECRET }, 'DREFYN_AUTH_SECRET_PREVIOUS');
  });

  it('one half of an OAuth pair, naming the missing half', () => {
    refuses({ DREFYN_AUTH_GITHUB_CLIENT_ID: 'Iv1.abc' }, 'DREFYN_AUTH_GITHUB_CLIENT_SECRET');
    refuses({ DREFYN_AUTH_GITHUB_CLIENT_SECRET: 'shh-0001' }, 'DREFYN_AUTH_GITHUB_CLIENT_ID');
    refuses({ DREFYN_AUTH_GOOGLE_CLIENT_ID: 'g.apps' }, 'DREFYN_AUTH_GOOGLE_CLIENT_SECRET');
    refuses({ DREFYN_AUTH_GOOGLE_CLIENT_SECRET: 'shh-0002' }, 'DREFYN_AUTH_GOOGLE_CLIENT_ID');
  });

  it('OAuth values with whitespace or control characters, or over 512 characters', () => {
    refuses(
      { DREFYN_AUTH_GITHUB_CLIENT_ID: 'Iv1 abc', DREFYN_AUTH_GITHUB_CLIENT_SECRET: 'x-secret' },
      'DREFYN_AUTH_GITHUB_CLIENT_ID',
    );
    refuses(
      { DREFYN_AUTH_GITHUB_CLIENT_ID: 'Iv1.abc', DREFYN_AUTH_GITHUB_CLIENT_SECRET: 'x\nsecret' },
      'DREFYN_AUTH_GITHUB_CLIENT_SECRET',
    );
    refuses(
      {
        DREFYN_AUTH_GOOGLE_CLIENT_ID: 'g'.repeat(513),
        DREFYN_AUTH_GOOGLE_CLIENT_SECRET: 'x-secret',
      },
      'DREFYN_AUTH_GOOGLE_CLIENT_ID',
    );
  });

  it('session days out of range, not plain digits, or idle above absolute', () => {
    for (const value of ['0', '91', 'abc', '1e1', ' 30', '30.0', '-1', '0x1e']) {
      refuses({ DREFYN_AUTH_SESSION_ABSOLUTE_DAYS: value }, 'DREFYN_AUTH_SESSION_ABSOLUTE_DAYS');
    }
    for (const value of ['0', '31']) {
      refuses({ DREFYN_AUTH_SESSION_IDLE_DAYS: value }, 'DREFYN_AUTH_SESSION_IDLE_DAYS');
    }
    refuses(
      { DREFYN_AUTH_SESSION_ABSOLUTE_DAYS: '5', DREFYN_AUTH_SESSION_IDLE_DAYS: '6' },
      'DREFYN_AUTH_SESSION_IDLE_DAYS',
    );
    refuses({ DREFYN_AUTH_SESSION_ABSOLUTE_DAYS: '6' }, 'DREFYN_AUTH_SESSION_IDLE_DAYS');
  });

  it('proxy hops out of range or above 0 on a loopback origin', () => {
    refuses({ DREFYN_TRUSTED_PROXY_HOPS: '11' }, 'DREFYN_TRUSTED_PROXY_HOPS');
    refuses({ DREFYN_TRUSTED_PROXY_HOPS: '-1' }, 'DREFYN_TRUSTED_PROXY_HOPS');
    refuses(
      {
        DREFYN_APP_ORIGIN: 'http://localhost:3000',
        DREFYN_AUTH_COOKIE_SECURE: 'false',
        DREFYN_TRUSTED_PROXY_HOPS: '1',
      },
      'DREFYN_TRUSTED_PROXY_HOPS',
    );
    refuses(
      { DREFYN_APP_ORIGIN: 'https://127.0.0.1:8443', DREFYN_TRUSTED_PROXY_HOPS: '1' },
      'DREFYN_TRUSTED_PROXY_HOPS',
    );
    refuses(
      { DREFYN_APP_ORIGIN: 'https://[::1]', DREFYN_TRUSTED_PROXY_HOPS: '1' },
      'DREFYN_TRUSTED_PROXY_HOPS',
    );
  });

  it('a client IP header other than the CloudFront one, or with no trusted hop to read it from', () => {
    refuses(
      { DREFYN_CLIENT_IP_HEADER: 'x-forwarded-for', DREFYN_TRUSTED_PROXY_HOPS: '1' },
      'DREFYN_CLIENT_IP_HEADER',
    );
    refuses({ DREFYN_CLIENT_IP_HEADER: 'cloudfront-viewer-address' }, 'DREFYN_CLIENT_IP_HEADER');
  });

  it('enumerations outside their values', () => {
    refuses({ DREFYN_AUTH_SIGNUP: 'invite-only' }, 'DREFYN_AUTH_SIGNUP');
    refuses({ DREFYN_AUTH_EMAIL: 'true' }, 'DREFYN_AUTH_EMAIL');
    refuses({ DREFYN_AUTH_PASSWORDS: 'ON' }, 'DREFYN_AUTH_PASSWORDS');
  });

  it('Argon2id parameters below the floor or above the ceiling', () => {
    const cases: [AuthConfigKey, string][] = [
      ['DREFYN_AUTH_PASSWORD_ARGON2_MEMORY_KIB', '19455'],
      ['DREFYN_AUTH_PASSWORD_ARGON2_MEMORY_KIB', '262145'],
      ['DREFYN_AUTH_PASSWORD_ARGON2_PASSES', '1'],
      ['DREFYN_AUTH_PASSWORD_ARGON2_PASSES', '11'],
      ['DREFYN_AUTH_PASSWORD_ARGON2_PARALLELISM', '0'],
      ['DREFYN_AUTH_PASSWORD_ARGON2_PARALLELISM', '5'],
      ['DREFYN_AUTH_PASSWORD_HASH_CONCURRENCY', '0'],
      ['DREFYN_AUTH_PASSWORD_HASH_CONCURRENCY', '17'],
      ['DREFYN_AUTH_PASSWORD_HASH_QUEUE_MAX', '1025'],
      ['DREFYN_AUTH_PASSWORD_HASH_QUEUE_MAX', 'many'],
    ];
    for (const [key, value] of cases) refuses({ [key]: value, UV_THREADPOOL_SIZE: '64' }, key);
  });

  it('a thread pool left at the default, and a hash concurrency of half the pool or more', () => {
    refuses({ UV_THREADPOOL_SIZE: undefined }, 'UV_THREADPOOL_SIZE');
    refuses({ UV_THREADPOOL_SIZE: '4' }, 'UV_THREADPOOL_SIZE');
    refuses({ UV_THREADPOOL_SIZE: '0' }, 'UV_THREADPOOL_SIZE');
    refuses({ UV_THREADPOOL_SIZE: '1025' }, 'UV_THREADPOOL_SIZE');
    refuses({ UV_THREADPOOL_SIZE: '8' }, 'DREFYN_AUTH_PASSWORD_HASH_CONCURRENCY');
    refuses(
      { UV_THREADPOOL_SIZE: '16', DREFYN_AUTH_PASSWORD_HASH_CONCURRENCY: '8' },
      'DREFYN_AUTH_PASSWORD_HASH_CONCURRENCY',
    );
    expect(
      parseAuthConfig(env({ UV_THREADPOOL_SIZE: '16', DREFYN_AUTH_PASSWORD_HASH_CONCURRENCY: '7' }))
        .passwords.hashConcurrency,
    ).toBe(7);
  });

  it('a breached list path that is not absolute or holds a NUL', () => {
    refuses(
      { DREFYN_AUTH_BREACHED_PASSWORDS_FILE: 'breached.bin' },
      'DREFYN_AUTH_BREACHED_PASSWORDS_FILE',
    );
    refuses(
      { DREFYN_AUTH_BREACHED_PASSWORDS_FILE: '/var/lib/x\u0000y' },
      'DREFYN_AUTH_BREACHED_PASSWORDS_FILE',
    );
  });

  it('a rate limit that does not read as count/window pairs', () => {
    for (const value of [
      '3',
      '3/',
      '/10m',
      '0/10m',
      '3/0m',
      '3/10w',
      '3/10m,',
      '3/10m, 10/1d',
      '3/10m,4/10m',
      '1000001/1m',
      '3/8d',
      '1/1s,2/2s,3/3s,4/4s',
      '3/10M',
    ]) {
      refuses({ DREFYN_AUTH_RATE_EMAIL_SEND: value }, 'DREFYN_AUTH_RATE_EMAIL_SEND');
    }
  });

  it('an unknown DREFYN_AUTH_ key, so a typo shows at start', () => {
    refuses({ DREFYN_AUTH_RATE_EMAL_SEND: '3/10m' }, 'DREFYN_AUTH_RATE_EMAL_SEND');
    refuses({ DREFYN_AUTH_SIGN_UP: 'open' }, 'DREFYN_AUTH_SIGN_UP');
  });

  it('a password reset bucket of its own, since it shares the email send limit', () => {
    refuses(
      { DREFYN_AUTH_RATE_PASSWORD_RESET_SEND: '3/10m' },
      'DREFYN_AUTH_RATE_PASSWORD_RESET_SEND',
    );
  });
});

describe('parseAuthConfig never echoes a secret', () => {
  // Values of at least 16 base64url symbols cannot occur in fixed message text by chance.
  const value = fc.string({
    unit: fc.constantFrom(
      ...Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'),
    ),
    minLength: 16,
    maxLength: 80,
  });
  const key = fc.constantFrom(
    ...AUTH_CONFIG_KEYS,
    'DREFYN_AUTH_RATE_EMAIL_SEND',
    'DREFYN_AUTH_EXTRA',
  );

  it('names the key and never the value, for any value in any key', () => {
    fc.assert(
      fc.property(key, value, fc.uint8Array({ minLength: 1, maxLength: 64 }), (k, v, bytes) => {
        const secret = base64url(bytes);
        const input = env({ DREFYN_AUTH_SECRET: secret, [k]: v });
        let error: unknown;
        try {
          parseAuthConfig(input);
          return;
        } catch (thrown) {
          error = thrown;
        }
        const text = [
          String(error),
          (error as Error).message,
          (error as Error).stack ?? '',
          JSON.stringify(error),
          inspect(error, { depth: 5 }),
        ].join('\n');
        expect(text).toContain('AUTH_CONFIG_INVALID');
        expect(text).not.toContain(v);
        if (secret.length >= 8) expect(text).not.toContain(secret);
      }),
      runs,
    );
  });

  it('keeps secrets out of a serialised or inspected config', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 64 }), value, (bytes, oauthSecret) => {
        const secret = base64url(bytes);
        const config = parseAuthConfig(
          env({
            DREFYN_AUTH_SECRET: secret,
            DREFYN_AUTH_GITHUB_CLIENT_ID: 'Iv1.abc',
            DREFYN_AUTH_GITHUB_CLIENT_SECRET: oauthSecret,
          }),
        );
        const text = `${JSON.stringify(config)}\n${inspect(config, { depth: 10, showHidden: true })}\n${String(config.oauth.github?.clientSecret)}`;
        expect(text).not.toContain(secret);
        expect(text).not.toContain(oauthSecret);
        expect(text).not.toContain(Buffer.from(bytes).toString('hex'));
      }),
      { ...runs, numRuns: 50 },
    );
  });

  it('puts the key on the error and nothing else from the environment', () => {
    const error = caught(() => parseAuthConfig(env({ DREFYN_AUTH_SECRET: 'short-secret-value' })));
    expect(Object.keys(error as object).sort()).toEqual(['code', 'key']);
  });
});

describe('parseApiAuthConfig', () => {
  const apiEnv = (patch: Env = {}): Env => ({ DREFYN_API_RATE_LIMIT_KEY: OTHER, ...patch });

  it('reads the API rate limit key and the failure limit', () => {
    const config = parseApiAuthConfig(apiEnv());
    expect(config.apiKeyFail).toEqual([{ count: 60, windowSeconds: 60 }]);
    const a = config.failureKey(['api_key_fail', '203.0.113.0/64']);
    expect(a).toHaveLength(32);
    expect(config.failureKey(['api_key_fail', '203.0.113.0/64']).equals(a)).toBe(true);
    expect(config.failureKey(['api_key_fail', '203.0.113.1']).equals(a)).toBe(false);
    expect(
      parseApiAuthConfig(apiEnv({ DREFYN_AUTH_RATE_API_KEY_FAIL: '100/1m' })).apiKeyFail,
    ).toEqual([{ count: 100, windowSeconds: 60 }]);
  });

  it('refuses a missing or short key, and the auth secret or auth database on the API service', () => {
    expectAuthError(
      () => parseApiAuthConfig({}),
      'AUTH_CONFIG_INVALID',
      'DREFYN_API_RATE_LIMIT_KEY',
    );
    expectAuthError(
      () => parseApiAuthConfig({ DREFYN_API_RATE_LIMIT_KEY: base64url(new Uint8Array(8)) }),
      'AUTH_CONFIG_INVALID',
      'DREFYN_API_RATE_LIMIT_KEY',
    );
    expectAuthError(
      () => parseApiAuthConfig(apiEnv({ DREFYN_AUTH_SECRET: SECRET })),
      'AUTH_CONFIG_INVALID',
      'DREFYN_AUTH_SECRET',
    );
    expectAuthError(
      () => parseApiAuthConfig(apiEnv({ DREFYN_AUTH_DATABASE_URL: 'postgres://x@y/z' })),
      'AUTH_CONFIG_INVALID',
      'DREFYN_AUTH_DATABASE_URL',
    );
    expectAuthError(
      () => parseApiAuthConfig(apiEnv({ DREFYN_AUTH_RATE_API_KEY_FAIL: 'lots' })),
      'AUTH_CONFIG_INVALID',
      'DREFYN_AUTH_RATE_API_KEY_FAIL',
    );
  });

  it('refuses every other DREFYN_AUTH_ key on the API service, each by name', () => {
    for (const key of [
      'DREFYN_AUTH_SECRET_PREVIOUS',
      'DREFYN_AUTH_GITHUB_CLIENT_ID',
      'DREFYN_AUTH_GITHUB_CLIENT_SECRET',
      'DREFYN_AUTH_GOOGLE_CLIENT_ID',
      'DREFYN_AUTH_GOOGLE_CLIENT_SECRET',
      'DREFYN_AUTH_DATABASE_POOL_MAX',
      'DREFYN_AUTH_SIGNUP',
      'DREFYN_AUTH_RATE_EMAIL_SEND',
      'DREFYN_AUTH_SOMETHING_NEW',
    ] as const) {
      expectAuthError(
        () => parseApiAuthConfig(apiEnv({ [key]: 'value-that-is-set' })),
        'AUTH_CONFIG_INVALID',
        key,
      );
    }
    // Compose passes an unset variable as an empty string.
    expect(parseApiAuthConfig(apiEnv({ DREFYN_AUTH_SECRET_PREVIOUS: '' })).apiKeyFail).toHaveLength(
      1,
    );
  });

  it('derives the failure key from its own secret, never from the auth secret', () => {
    const one = parseApiAuthConfig(apiEnv()).failureKey(['x']);
    const two = parseApiAuthConfig(apiEnv({ DREFYN_API_RATE_LIMIT_KEY: SECRET })).failureKey(['x']);
    expect(one.equals(two)).toBe(false);
    expect(JSON.stringify(parseApiAuthConfig(apiEnv()))).not.toContain(OTHER);
  });
});

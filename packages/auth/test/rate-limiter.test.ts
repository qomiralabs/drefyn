import type { ApiKeyLimiterSchema, AuthSchema, WindowCount } from '@drefyn/db';
import type { Transaction } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import {
  AuthError,
  RATE_BUCKETS,
  createApiKeyFailureLimiter,
  createRateLimiter,
  deriveAuthKeys,
  parseApiAuthConfig,
  parseAuthConfig,
  rateKeyForIp,
  type RateBucket,
} from '../src/index.ts';
import { base64url, validEnv } from './support.ts';

const tx = {} as Transaction<AuthSchema>;
const apiTx = {} as Transaction<ApiKeyLimiterSchema>;
const keys = deriveAuthKeys(new Uint8Array(32).fill(7));
const { rateLimits } = parseAuthConfig(validEnv());

interface Request {
  readonly bucket: string;
  readonly keyHmac: Uint8Array;
  readonly windowSeconds: readonly number[];
}

// Answers each window with the given count and a retry of the window's own length.
function store(count: (windowSeconds: number) => number) {
  const requests: Request[] = [];
  const reserve = vi.fn((_tx: unknown, request: Request): Promise<readonly WindowCount[]> => {
    requests.push(request);
    return Promise.resolve(
      request.windowSeconds.map((windowSeconds) => ({
        windowSeconds,
        count: count(windowSeconds),
        retryAfterSeconds: Math.ceil(windowSeconds / 2),
      })),
    );
  });
  return { reserve, requests };
}

async function limited(promise: Promise<unknown>): Promise<AuthError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AuthError);
  expect((error as AuthError).code).toBe('AUTH_RATE_LIMITED');
  return error as AuthError;
}

describe('the bucket list', () => {
  it('holds every bucket in the limits table, the known device bucket included', () => {
    expect([...RATE_BUCKETS].sort()).toEqual(
      [
        'code_verify',
        'email_send',
        'email_send_address_ceiling',
        'email_send_device',
        'email_send_ip',
        'invite_recipient',
        'invite_send',
        'invite_send_user',
        'oauth_start',
        'org_create',
        'password_fail',
        'password_fail_ip',
      ].sort(),
    );
    expect(rateLimits.email_send_device).toEqual([{ count: 10, windowSeconds: 86_400 }]);
    expect(rateLimits.email_send).toEqual([
      { count: 3, windowSeconds: 600 },
      { count: 10, windowSeconds: 86_400 },
    ]);
    expect(rateLimits.email_send_address_ceiling).toEqual([{ count: 30, windowSeconds: 86_400 }]);
  });
});

describe('createRateLimiter', () => {
  it('keys each bucket with HMAC(subkey_rate, bucket, value) and sends every window', async () => {
    const { reserve, requests } = store(() => 1);
    const limiter = createRateLimiter({ keys, limits: rateLimits, reserve });
    await limiter.reserve(tx, 'email_send', ['a@example.com', rateKeyForIp('203.0.113.7')]);
    expect(requests).toEqual([
      {
        bucket: 'email_send',
        keyHmac: keys.mac('rate', ['email_send', 'a@example.com', 'ip4:203.0.113.7']),
        windowSeconds: [600, 86_400],
      },
    ]);
    expect(limiter.keyFor('email_send', ['a@example.com', 'ip4:203.0.113.7'])).toEqual(
      requests[0]?.keyHmac,
    );
  });

  it('gives each bucket its own key for the same value', () => {
    const limiter = createRateLimiter({ keys, limits: rateLimits });
    const seen = new Set(
      RATE_BUCKETS.map((bucket) => limiter.keyFor(bucket, ['same']).toString('hex')),
    );
    expect(seen.size).toBe(RATE_BUCKETS.length);
  });

  it('shares a bucket for two addresses in one /64 and splits two /64s', () => {
    const limiter = createRateLimiter({ keys, limits: rateLimits });
    const key = (ip: string) => limiter.keyFor('email_send_ip', [rateKeyForIp(ip)]).toString('hex');
    expect(key('2001:db8:1:2::1')).toBe(key('2001:db8:1:2:aaaa:bbbb:cccc:dddd'));
    expect(key('2001:db8:1:2::1')).not.toBe(key('2001:db8:1:3::1'));
  });

  it('lets the limit through and refuses the next with the longest retry', async () => {
    const atLimit = createRateLimiter({
      keys,
      limits: rateLimits,
      reserve: store(() => 3).reserve,
    });
    await atLimit.reserve(tx, 'email_send', ['a']);
    const over = createRateLimiter({
      keys,
      limits: rateLimits,
      // Over the 10 minute limit of 3 and under the daily limit of 10.
      reserve: store((w) => (w === 600 ? 4 : 4)).reserve,
    });
    const error = await limited(over.reserve(tx, 'email_send', ['a']));
    expect(error.retryAfterSeconds).toBe(300);
    const both = createRateLimiter({
      keys,
      limits: rateLimits,
      reserve: store(() => 11).reserve,
    });
    expect((await limited(both.reserve(tx, 'email_send', ['a']))).retryAfterSeconds).toBe(43_200);
  });

  it('records auth.email_ceiling_hit and logs only the hashed key when the ceiling is hit', async () => {
    const increment = vi.fn();
    const warn = vi.fn();
    const limiter = createRateLimiter({
      keys,
      limits: rateLimits,
      reserve: store(() => 31).reserve,
      metrics: { increment },
      logger: { warn },
    });
    await limited(limiter.reserve(tx, 'email_send_address_ceiling', ['victim@example.com']));
    expect(increment).toHaveBeenCalledWith('auth.email_ceiling_hit');
    const hashed = keys
      .mac('rate', ['email_send_address_ceiling', 'victim@example.com'])
      .toString('hex')
      .slice(0, 16);
    expect(warn).toHaveBeenCalledWith('auth.email_ceiling_hit', {
      bucket: 'email_send_address_ceiling',
      key: hashed,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('victim');
  });

  it('records nothing at the ceiling itself, or when another bucket is over', async () => {
    const increment = vi.fn();
    const warn = vi.fn();
    const at = createRateLimiter({
      keys,
      limits: rateLimits,
      reserve: store(() => 30).reserve,
      metrics: { increment },
      logger: { warn },
    });
    await at.reserve(tx, 'email_send_address_ceiling', ['a']);
    const other = createRateLimiter({
      keys,
      limits: rateLimits,
      reserve: store(() => 99).reserve,
      metrics: { increment },
      logger: { warn },
    });
    await limited(other.reserve(tx, 'email_send', ['a']));
    expect(increment).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('still refuses when the metric or the logger throws', async () => {
    const limiter = createRateLimiter({
      keys,
      limits: rateLimits,
      reserve: store(() => 31).reserve,
      metrics: {
        increment: () => {
          throw new Error('metrics down');
        },
      },
      logger: {
        warn: () => {
          throw new Error('logs down');
        },
      },
    });
    await limited(limiter.reserve(tx, 'email_send_address_ceiling', ['a']));
  });

  it('refuses a bucket it does not know before any SQL', async () => {
    const { reserve } = store(() => 1);
    const limiter = createRateLimiter({ keys, limits: rateLimits, reserve });
    const error = await limiter.reserve(tx, 'email_bomb' as RateBucket, ['a']).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).code).toBe('AUTH_INPUT_INVALID');
    expect(reserve).not.toHaveBeenCalled();
  });

  it('turns a database failure into AUTH_UNAVAILABLE and keeps the cause', async () => {
    const cause = new Error('connection lost');
    const limiter = createRateLimiter({
      keys,
      limits: rateLimits,
      reserve: () => Promise.reject(cause),
    });
    const error = await limiter.reserve(tx, 'oauth_start', ['ip4:203.0.113.7']).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).code).toBe('AUTH_UNAVAILABLE');
    expect((error as AuthError).cause).toBe(cause);
  });
});

describe('createApiKeyFailureLimiter', () => {
  const config = parseApiAuthConfig({
    DREFYN_API_RATE_LIMIT_KEY: base64url(new Uint8Array(32).fill(9)),
  });

  it('keys with the API rate limit key, never the auth secret', async () => {
    const requests: { keyHmac: Uint8Array; windowSeconds: readonly number[] }[] = [];
    const limiter = createApiKeyFailureLimiter({
      config,
      reserve: (_tx, request) => {
        requests.push(request);
        return Promise.resolve([{ windowSeconds: 60, count: 1, retryAfterSeconds: 30 }]);
      },
    });
    await limiter.reserve(apiTx, rateKeyForIp('2001:db8:1:2::9'));
    expect(requests).toEqual([
      {
        keyHmac: config.failureKey(['api_key_fail', 'ip6:2001:0db8:0001:0002::/64']),
        windowSeconds: [60],
      },
    ]);
    expect(requests[0]?.keyHmac).not.toEqual(
      keys.mac('rate', ['api_key_fail', 'ip6:2001:0db8:0001:0002::/64']),
    );
  });

  it('refuses past 60 failures a minute', async () => {
    const limiter = createApiKeyFailureLimiter({
      config,
      reserve: () => Promise.resolve([{ windowSeconds: 60, count: 61, retryAfterSeconds: 12 }]),
    });
    const error = await limited(limiter.reserve(apiTx, 'ip4:203.0.113.7'));
    expect(error.retryAfterSeconds).toBe(12);
    const at = createApiKeyFailureLimiter({
      config,
      reserve: () => Promise.resolve([{ windowSeconds: 60, count: 60, retryAfterSeconds: 12 }]),
    });
    await at.reserve(apiTx, 'ip4:203.0.113.7');
  });
});

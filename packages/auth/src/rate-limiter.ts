import {
  reserveApiKeyFailureWindows,
  reserveAuthRateWindows,
  type ApiKeyFailureRequest,
  type ApiKeyLimiterSchema,
  type AuthSchema,
  type RateWindowRequest,
  type WindowCount,
} from '@drefyn/db';
import type { Transaction } from 'kysely';
import { RATE_BUCKETS, type RateBucket } from './config-keys.ts';
import type { ApiAuthConfig, RateLimit } from './config.ts';
import { AuthError } from './errors.ts';
import type { AuthKeys, MacPart } from './keys.ts';

export type AuthMetricName = 'auth.email_ceiling_hit';

export interface AuthMetrics {
  increment(name: AuthMetricName): void;
}

// Fields are ids, bucket names and hashed keys; never an address, an IP or a code.
export interface AuthLogger {
  warn(event: string, fields: Readonly<Record<string, string | number | boolean>>): void;
}

export interface RateLimiterDeps {
  readonly keys: AuthKeys;
  readonly limits: Readonly<Record<RateBucket, readonly RateLimit[]>>;
  readonly metrics?: AuthMetrics;
  readonly logger?: AuthLogger;
  readonly reserve?: (
    tx: Transaction<AuthSchema>,
    request: RateWindowRequest,
  ) => Promise<readonly WindowCount[]>;
}

export interface RateLimiter {
  // The stored key for a bucket and value: HMAC(subkey_rate, bucket, ...value).
  keyFor(bucket: RateBucket, value: readonly MacPart[]): Buffer;
  // Counts one attempt and refuses with AUTH_RATE_LIMITED when any window is past its limit.
  // Call it first in the withAuth transaction, before the work it limits.
  reserve(
    tx: Transaction<AuthSchema>,
    bucket: RateBucket,
    value: readonly MacPart[],
  ): Promise<void>;
}

const CEILING: RateBucket = 'email_send_address_ceiling';
const KNOWN: ReadonlySet<string> = new Set(RATE_BUCKETS);
// Enough of the HMAC for an operator to tie log lines together; it says nothing of the address.
const LOGGED_KEY_HEX = 16;

// The refusal for the first window past its limit, or null. The retry is the longest of the
// windows that refused, since every one of them has to reopen.
function refusal(counts: readonly WindowCount[], limits: readonly RateLimit[]): AuthError | null {
  let retry = 0;
  for (const window of counts) {
    const limit = limits.find((l) => l.windowSeconds === window.windowSeconds);
    if (limit !== undefined && window.count > limit.count) {
      retry = Math.max(retry, window.retryAfterSeconds);
    }
  }
  return retry === 0 ? null : new AuthError('AUTH_RATE_LIMITED', { retryAfterSeconds: retry });
}

async function counted<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new AuthError('AUTH_UNAVAILABLE', { cause: error });
  }
}

function quietly(effect: () => void): void {
  try {
    effect();
  } catch {
    // Metrics and logs are best effort; the refusal stands either way.
  }
}

export function createRateLimiter(deps: RateLimiterDeps): RateLimiter {
  const reserve = deps.reserve ?? reserveAuthRateWindows;
  const keyFor = (bucket: RateBucket, value: readonly MacPart[]) =>
    deps.keys.mac('rate', [bucket, ...value]);
  return Object.freeze({
    keyFor,
    async reserve(tx: Transaction<AuthSchema>, bucket: RateBucket, value: readonly MacPart[]) {
      if (!KNOWN.has(bucket)) throw new AuthError('AUTH_INPUT_INVALID');
      const limits = deps.limits[bucket];
      const keyHmac = keyFor(bucket, value);
      const counts = await counted(() =>
        reserve(tx, { bucket, keyHmac, windowSeconds: limits.map((l) => l.windowSeconds) }),
      );
      const refused = refusal(counts, limits);
      if (refused === null) return;
      // Strangers flooding one address: an operator needs to see it as it happens.
      if (bucket === CEILING) {
        quietly(() => deps.metrics?.increment('auth.email_ceiling_hit'));
        quietly(() =>
          deps.logger?.warn('auth.email_ceiling_hit', {
            bucket,
            key: keyHmac.toString('hex').slice(0, LOGGED_KEY_HEX),
          }),
        );
      }
      throw refused;
    },
  });
}

export interface ApiKeyFailureLimiterDeps {
  readonly config: ApiAuthConfig;
  readonly reserve?: (
    tx: Transaction<ApiKeyLimiterSchema>,
    request: ApiKeyFailureRequest,
  ) => Promise<readonly WindowCount[]>;
}

export interface ApiKeyFailureLimiter {
  // Counts one failed key check for a client key from rateKeyForIp, inside withApiKeyLimiter.
  reserve(tx: Transaction<ApiKeyLimiterSchema>, clientKey: string): Promise<void>;
}

// The API service's limiter: its own HMAC key, its own table, no auth secret or role.
export function createApiKeyFailureLimiter(deps: ApiKeyFailureLimiterDeps): ApiKeyFailureLimiter {
  const reserve = deps.reserve ?? reserveApiKeyFailureWindows;
  const limits = deps.config.apiKeyFail;
  return Object.freeze({
    async reserve(tx: Transaction<ApiKeyLimiterSchema>, clientKey: string) {
      const keyHmac = deps.config.failureKey(['api_key_fail', clientKey]);
      const counts = await counted(() =>
        reserve(tx, { keyHmac, windowSeconds: limits.map((l) => l.windowSeconds) }),
      );
      const refused = refusal(counts, limits);
      if (refused !== null) throw refused;
    },
  });
}

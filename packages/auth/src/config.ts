import { z } from 'zod';
import { cookieNames, type CookieNames } from './cookies.ts';
import {
  AUTH_CONFIG_KEYS,
  RATE_BUCKETS,
  rateKey,
  type AuthConfigKey,
  type RateBucket,
} from './config-keys.ts';
import { AuthError } from './errors.ts';
import {
  MIN_SECRET_BYTES,
  deriveAuthKeys,
  lengthPrefixed,
  type AuthKeys,
  type MacPart,
} from './keys.ts';
import { createHmac, createSecretKey, hkdfSync } from 'node:crypto';
import { SecretValue } from './secret-value.ts';

export type Env = Readonly<Record<string, string | undefined>>;
export type SignUpMode = 'open' | 'invite_only' | 'closed';
export type EmailMode = 'on' | 'off' | 'auto';

export interface RateLimit {
  readonly count: number;
  readonly windowSeconds: number;
}

export interface OAuthClient {
  readonly clientId: string;
  readonly clientSecret: SecretValue;
}

export interface AuthConfig {
  readonly appOrigin: string;
  readonly keys: AuthKeys;
  readonly signUp: SignUpMode;
  // auto: on when the app wires a working email transport, which only the app knows.
  readonly email: EmailMode;
  readonly oauth: { readonly github: OAuthClient | null; readonly google: OAuthClient | null };
  readonly session: { readonly absoluteDays: number; readonly idleDays: number };
  readonly cookieSecure: boolean;
  readonly cookies: CookieNames;
  readonly trustedProxyHops: number;
  readonly clientIpHeader: 'cloudfront-viewer-address' | null;
  readonly rateLimits: Readonly<Record<RateBucket, readonly RateLimit[]>>;
  readonly passwords: {
    readonly enabled: boolean;
    readonly argon2: {
      readonly memoryKib: number;
      readonly passes: number;
      readonly parallelism: number;
    };
    readonly hashConcurrency: number;
    readonly hashQueueMax: number;
    readonly breachedPasswordsFile: string | null;
  };
  // null when unset, which leaves libuv at its default of 4.
  readonly threadPoolSize: number | null;
}

const DEFAULT_RATE_LIMITS: Readonly<Record<RateBucket, string>> = {
  email_send: '3/10m,10/1d',
  email_send_address_ceiling: '30/1d',
  email_send_ip: '20/10m',
  code_verify: '10/1h',
  oauth_start: '30/10m',
  org_create: '3/1d',
  invite_send_user: '50/1h',
  invite_recipient: '5/1d',
  invite_send: '50/1h',
  password_fail: '10/15m',
  password_fail_ip: '30/10m',
};

// Every reason is fixed text: a value may be a secret pasted into the wrong key.
function invalid(key: AuthConfigKey, reason: string): never {
  throw new AuthError('AUTH_CONFIG_INVALID', { key, reason });
}

// Compose passes an unset variable as an empty string.
function read(env: Env, key: string): string | undefined {
  const value = env[key];
  return value === undefined || value === '' ? undefined : value;
}

function take<T>(key: AuthConfigKey, schema: z.ZodType<T>, raw: unknown, reason: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) invalid(key, reason);
  return parsed.data;
}

// Plain digits only: Number() would also take ' 30', '1e1', '0x1e' and 'Infinity'.
const whole = (min: number, max: number) =>
  z
    .string()
    .regex(/^[0-9]{1,7}$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

function wholeKey(env: Env, key: AuthConfigKey, fallback: number, min: number, max: number) {
  const raw = read(env, key);
  if (raw === undefined) return fallback;
  return take(key, whole(min, max), raw, `must be a whole number from ${min} to ${max}`);
}

function choice<const T extends readonly [string, ...string[]]>(
  env: Env,
  key: AuthConfigKey,
  values: T,
  fallback: T[number],
): T[number] {
  const raw = read(env, key);
  if (raw === undefined) return fallback;
  return take(key, z.enum(values), raw, `must be one of ${values.join(', ')}`);
}

// Canonical unpadded base64url only, so one secret has one spelling and a stray
// character is an error rather than silently ignored by the decoder.
const base64url = z
  .string()
  .max(4096)
  .regex(/^[A-Za-z0-9_-]+$/)
  .transform((text) => Buffer.from(text, 'base64url'))
  .refine((bytes) => bytes.length >= MIN_SECRET_BYTES);

function secretKey(env: Env, key: AuthConfigKey): Buffer | undefined {
  const raw = read(env, key);
  if (raw === undefined) return undefined;
  const bytes = take(key, base64url, raw, 'must be at least 32 random bytes in unpadded base64url');
  if (bytes.toString('base64url') !== raw) {
    invalid(key, 'must be at least 32 random bytes in unpadded base64url');
  }
  return bytes;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);
const HTTP_LOOPBACK: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

function parseOrigin(raw: string | undefined): URL {
  const reason = 'must be an http or https origin with no path, query, fragment or user';
  if (raw === undefined) invalid('DREFYN_APP_ORIGIN', 'is required');
  const url = URL.parse(raw);
  if (url === null) return invalid('DREFYN_APP_ORIGIN', reason);
  const plain =
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.hostname !== '' &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '' &&
    !raw.includes('?') &&
    !raw.includes('#');
  if (!plain) invalid('DREFYN_APP_ORIGIN', reason);
  return url;
}

const OAUTH_VALUE = z
  .string()
  .max(512)
  .regex(/^[\x21-\x7e]+$/);

function oauthPair(env: Env, provider: 'GITHUB' | 'GOOGLE'): OAuthClient | null {
  const idKey = `DREFYN_AUTH_${provider}_CLIENT_ID` as const;
  const secretKeyName = `DREFYN_AUTH_${provider}_CLIENT_SECRET` as const;
  const id = read(env, idKey);
  const secret = read(env, secretKeyName);
  if (id === undefined && secret === undefined) return null;
  if (id === undefined) invalid(idKey, `is required when ${secretKeyName} is set`);
  if (secret === undefined) invalid(secretKeyName, `is required when ${idKey} is set`);
  const reason = 'must be 1 to 512 printable characters with no spaces';
  const clientId = take(idKey, OAUTH_VALUE, id, reason);
  take(secretKeyName, OAUTH_VALUE, secret, reason);
  return Object.freeze({ clientId, clientSecret: new SecretValue(secret) });
}

const UNIT_SECONDS: Readonly<Record<string, number>> = { s: 1, m: 60, h: 3600, d: 86_400 };
const MAX_WINDOW_SECONDS = 7 * 86_400;
const RATE_ITEM = /^([0-9]{1,7})\/([0-9]{1,5})([smhd])$/;

// "3/10m,10/1d": up to three count/window pairs with distinct windows, no spaces.
const rateSpec = z.string().transform((text, ctx) => {
  const items = text.split(',');
  const limits: RateLimit[] = [];
  for (const item of items) {
    const match = RATE_ITEM.exec(item);
    const count = Number(match?.[1]);
    const windowSeconds = Number(match?.[2]) * (UNIT_SECONDS[match?.[3] ?? ''] ?? Number.NaN);
    const fits =
      Number.isInteger(count) &&
      count >= 1 &&
      count <= 1_000_000 &&
      Number.isInteger(windowSeconds) &&
      windowSeconds >= 1 &&
      windowSeconds <= MAX_WINDOW_SECONDS &&
      !limits.some((limit) => limit.windowSeconds === windowSeconds);
    if (!fits) {
      ctx.addIssue({ code: 'custom' });
      return z.NEVER;
    }
    limits.push(Object.freeze({ count, windowSeconds }));
  }
  if (limits.length > 3) {
    ctx.addIssue({ code: 'custom' });
    return z.NEVER;
  }
  return Object.freeze(limits);
});

function rateLimits(env: Env, key: AuthConfigKey, fallback: string): readonly RateLimit[] {
  return take(
    key,
    rateSpec,
    read(env, key) ?? fallback,
    'must be 1 to 3 count/window pairs such as 3/10m,10/1d, windows in s, m, h or d up to 7d',
  );
}

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  ...AUTH_CONFIG_KEYS,
  // Read by @drefyn/db for the auth pool, not here.
  'DREFYN_AUTH_DATABASE_URL',
  'DREFYN_AUTH_DATABASE_POOL_MAX',
  // Read by the API service through parseApiAuthConfig.
  'DREFYN_AUTH_RATE_API_KEY_FAIL',
]);

function refuseUnknownKeys(env: Env) {
  for (const key of Object.keys(env).sort()) {
    if (key.startsWith('DREFYN_AUTH_') && !KNOWN_KEYS.has(key)) {
      invalid(key as AuthConfigKey, 'is not a known auth setting');
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

// Reads the dashboard's auth settings. Any problem throws AUTH_CONFIG_INVALID naming the
// key and a fixed reason, never the value.
export function parseAuthConfig(env: Env): AuthConfig {
  refuseUnknownKeys(env);

  const origin = parseOrigin(read(env, 'DREFYN_APP_ORIGIN'));
  const loopback = LOOPBACK_HOSTS.has(origin.hostname);

  const cookieSecure =
    choice(env, 'DREFYN_AUTH_COOKIE_SECURE', ['true', 'false'], 'true') === 'true';
  if (!cookieSecure && !(origin.protocol === 'http:' && HTTP_LOOPBACK.has(origin.hostname))) {
    invalid(
      'DREFYN_AUTH_COOKIE_SECURE',
      'may be false only for an http://localhost or http://127.0.0.1 origin',
    );
  }
  if (cookieSecure && origin.protocol !== 'https:') {
    invalid('DREFYN_APP_ORIGIN', 'must be https while secure cookies are on');
  }

  const secret = secretKey(env, 'DREFYN_AUTH_SECRET');
  if (secret === undefined) invalid('DREFYN_AUTH_SECRET', 'is required');
  const previous = secretKey(env, 'DREFYN_AUTH_SECRET_PREVIOUS');
  if (previous?.equals(secret) === true) {
    invalid(
      'DREFYN_AUTH_SECRET_PREVIOUS',
      'equals DREFYN_AUTH_SECRET, so no rotation is under way',
    );
  }

  const github = oauthPair(env, 'GITHUB');
  const google = oauthPair(env, 'GOOGLE');

  const absoluteDays = wholeKey(env, 'DREFYN_AUTH_SESSION_ABSOLUTE_DAYS', 30, 1, 90);
  const idleDays = wholeKey(env, 'DREFYN_AUTH_SESSION_IDLE_DAYS', 7, 1, 30);
  if (idleDays > absoluteDays) {
    invalid('DREFYN_AUTH_SESSION_IDLE_DAYS', 'must not be above DREFYN_AUTH_SESSION_ABSOLUTE_DAYS');
  }

  const hopsRaw = read(env, 'DREFYN_TRUSTED_PROXY_HOPS');
  const trustedProxyHops =
    hopsRaw === undefined
      ? 0
      : take(
          'DREFYN_TRUSTED_PROXY_HOPS',
          whole(0, 10),
          hopsRaw,
          'must be a whole number from 0 to 10',
        );
  // A loopback origin has nothing in front of it, so a forwarded address would be the
  // client's own claim.
  if (trustedProxyHops > 0 && loopback) {
    invalid('DREFYN_TRUSTED_PROXY_HOPS', 'must be 0 for a loopback origin');
  }

  const header = read(env, 'DREFYN_CLIENT_IP_HEADER');
  if (header !== undefined && header !== 'cloudfront-viewer-address') {
    invalid('DREFYN_CLIENT_IP_HEADER', 'must be cloudfront-viewer-address or unset');
  }
  if (header !== undefined && trustedProxyHops === 0) {
    invalid(
      'DREFYN_CLIENT_IP_HEADER',
      'is read only from a trusted hop, so it needs hops of 1 or more',
    );
  }

  const signUp = choice(
    env,
    'DREFYN_AUTH_SIGNUP',
    ['open', 'invite_only', 'closed'],
    'invite_only',
  );
  const emailRaw = read(env, 'DREFYN_AUTH_EMAIL');
  const email: EmailMode =
    emailRaw === undefined ? 'auto' : choice(env, 'DREFYN_AUTH_EMAIL', ['on', 'off'], 'on');

  const enabled = choice(env, 'DREFYN_AUTH_PASSWORDS', ['on', 'off'], 'on') === 'on';
  const memoryKib = wholeKey(
    env,
    'DREFYN_AUTH_PASSWORD_ARGON2_MEMORY_KIB',
    19_456,
    19_456,
    262_144,
  );
  const passes = wholeKey(env, 'DREFYN_AUTH_PASSWORD_ARGON2_PASSES', 2, 2, 10);
  const parallelism = wholeKey(env, 'DREFYN_AUTH_PASSWORD_ARGON2_PARALLELISM', 1, 1, 4);
  const hashConcurrency = wholeKey(env, 'DREFYN_AUTH_PASSWORD_HASH_CONCURRENCY', 4, 1, 16);
  const hashQueueMax = wholeKey(env, 'DREFYN_AUTH_PASSWORD_HASH_QUEUE_MAX', 64, 0, 1024);

  const fileRaw = read(env, 'DREFYN_AUTH_BREACHED_PASSWORDS_FILE');
  if (fileRaw !== undefined && (!fileRaw.startsWith('/') || fileRaw.includes('\u0000'))) {
    invalid('DREFYN_AUTH_BREACHED_PASSWORDS_FILE', 'must be an absolute path');
  }

  // Hashes run on the libuv pool that DNS lookups and file reads share, so a pool left at
  // 4, or one that hashing can fill halfway, stalls every other sign in method.
  const poolRaw = read(env, 'UV_THREADPOOL_SIZE');
  const threadPoolSize =
    poolRaw === undefined
      ? null
      : take(
          'UV_THREADPOOL_SIZE',
          whole(1, 1024),
          poolRaw,
          'must be a whole number from 1 to 1024',
        );
  if (enabled) {
    if (threadPoolSize === null || threadPoolSize <= 4) {
      invalid('UV_THREADPOOL_SIZE', 'must be set above the default of 4 while passwords are on');
    }
    if (hashConcurrency * 2 >= threadPoolSize) {
      invalid('DREFYN_AUTH_PASSWORD_HASH_CONCURRENCY', 'must be under half of UV_THREADPOOL_SIZE');
    }
  }

  const limits = {} as Record<RateBucket, readonly RateLimit[]>;
  for (const bucket of RATE_BUCKETS) {
    limits[bucket] = rateLimits(env, rateKey(bucket), DEFAULT_RATE_LIMITS[bucket]);
  }

  return deepFreeze({
    appOrigin: origin.origin,
    keys: deriveAuthKeys(secret, previous ?? null),
    signUp,
    email,
    oauth: { github, google },
    session: { absoluteDays, idleDays },
    cookieSecure,
    cookies: cookieNames(cookieSecure),
    trustedProxyHops,
    clientIpHeader: header === undefined ? null : 'cloudfront-viewer-address',
    rateLimits: limits,
    passwords: {
      enabled,
      argon2: { memoryKib, passes, parallelism },
      hashConcurrency,
      hashQueueMax,
      breachedPasswordsFile: fileRaw ?? null,
    },
    threadPoolSize,
  });
}

export interface ApiAuthConfig {
  // HMAC for api_key_failures rows, so the table never holds an IP.
  failureKey(parts: readonly MacPart[]): Buffer;
  readonly apiKeyFail: readonly RateLimit[];
}

// The API service's side: its own failure key and limit, and a refusal to start with the
// auth secret or the auth database, which read every address and password hash.
export function parseApiAuthConfig(env: Env): ApiAuthConfig {
  for (const key of ['DREFYN_AUTH_SECRET', 'DREFYN_AUTH_DATABASE_URL'] as const) {
    if (read(env, key) !== undefined) invalid(key, 'must not be set on the API service');
  }
  const key = secretKey(env, 'DREFYN_API_RATE_LIMIT_KEY');
  if (key === undefined) invalid('DREFYN_API_RATE_LIMIT_KEY', 'is required');
  const apiKeyFail = rateLimits(env, 'DREFYN_AUTH_RATE_API_KEY_FAIL', '60/1m');
  const subkey = createSecretKey(
    Buffer.from(hkdfSync('sha256', key, 'drefyn.auth.hkdf.v1', 'drefyn/api/v1/api_key_fail', 32)),
  );
  return Object.freeze({
    apiKeyFail,
    failureKey: (parts: readonly MacPart[]) =>
      createHmac('sha256', subkey).update(lengthPrefixed(parts)).digest(),
  });
}

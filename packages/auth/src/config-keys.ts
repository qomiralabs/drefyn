export const RATE_BUCKETS = Object.freeze([
  'email_send',
  'email_send_address_ceiling',
  'email_send_ip',
  'code_verify',
  'oauth_start',
  'org_create',
  'invite_send_user',
  'invite_recipient',
  'invite_send',
  'password_fail',
  'password_fail_ip',
] as const);

export type RateBucket = (typeof RATE_BUCKETS)[number];

type RateKey = `DREFYN_AUTH_RATE_${Uppercase<RateBucket>}`;

const rateKey = (bucket: RateBucket) => `DREFYN_AUTH_RATE_${bucket.toUpperCase()}` as RateKey;

export const AUTH_CONFIG_KEYS = Object.freeze([
  'DREFYN_APP_ORIGIN',
  'DREFYN_AUTH_SECRET',
  'DREFYN_AUTH_SECRET_PREVIOUS',
  'DREFYN_CLIENT_IP_HEADER',
  'DREFYN_AUTH_PASSWORD_HASH_QUEUE_MAX',
  'UV_THREADPOOL_SIZE',
  'DREFYN_AUTH_SIGNUP',
  'DREFYN_AUTH_EMAIL',
  'DREFYN_AUTH_GITHUB_CLIENT_ID',
  'DREFYN_AUTH_GITHUB_CLIENT_SECRET',
  'DREFYN_AUTH_GOOGLE_CLIENT_ID',
  'DREFYN_AUTH_GOOGLE_CLIENT_SECRET',
  'DREFYN_AUTH_SESSION_ABSOLUTE_DAYS',
  'DREFYN_AUTH_SESSION_IDLE_DAYS',
  'DREFYN_AUTH_COOKIE_SECURE',
  'DREFYN_TRUSTED_PROXY_HOPS',
  'DREFYN_AUTH_PASSWORDS',
  'DREFYN_AUTH_PASSWORD_ARGON2_MEMORY_KIB',
  'DREFYN_AUTH_PASSWORD_ARGON2_PASSES',
  'DREFYN_AUTH_PASSWORD_ARGON2_PARALLELISM',
  'DREFYN_AUTH_PASSWORD_HASH_CONCURRENCY',
  'DREFYN_AUTH_BREACHED_PASSWORDS_FILE',
  ...RATE_BUCKETS.map(rateKey),
] as const);

export type KnownAuthConfigKey =
  | Exclude<(typeof AUTH_CONFIG_KEYS)[number], RateKey>
  | RateKey
  | 'DREFYN_API_RATE_LIMIT_KEY'
  | 'DREFYN_AUTH_RATE_API_KEY_FAIL'
  | 'DREFYN_AUTH_DATABASE_URL';

// An unknown DREFYN_AUTH_ key is named back too, so a typo fails at start.
export type AuthConfigKey = KnownAuthConfigKey | `DREFYN_AUTH_${string}`;

export { rateKey };

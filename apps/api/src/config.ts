import { z } from 'zod';

export type Env = Readonly<Record<string, string | undefined>>;

export interface ApiConfig {
  readonly port: number;
  readonly host: string;
  // Written into openapi.json, so clients learn where to call.
  readonly publicUrl: string;
  readonly maxBodyBytes: number;
  readonly hops: number;
  // Read CloudFront-Viewer-Address from the trusted hop instead of the chain.
  readonly viewerHeader: boolean;
}

export class ApiConfigError extends Error {
  readonly key: string;

  // Fixed text only: a value may be a secret pasted into the wrong key.
  constructor(key: string, reason: string) {
    super(`${key} ${reason}`);
    this.key = key;
  }
}
Object.defineProperty(ApiConfigError.prototype, 'name', { value: 'ApiConfigError' });

const DEFAULT_PORT = 3100;
const DEFAULT_BODY_BYTES = 1_048_576;
const MAX_BODY_BYTES = 64 * 1_048_576;
const MAX_HOPS = 10;
const LOOPBACK_NAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

// Compose passes an unset variable as an empty string.
function read(env: Env, key: string): string | undefined {
  const value = env[key];
  return value === undefined || value === '' ? undefined : value;
}

// Plain digits only: Number() would also take ' 80', '1e3' and '0x50'.
const whole = (min: number, max: number) =>
  z
    .string()
    .regex(/^[0-9]{1,9}$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

function take<T>(env: Env, key: string, schema: z.ZodType<T>, fallback: T, reason: string): T {
  const raw = read(env, key);
  if (raw === undefined) return fallback;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ApiConfigError(key, reason);
  return parsed.data;
}

function parsePublicUrl(raw: string): string {
  const url = URL.parse(raw);
  const plain =
    url !== null &&
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.hostname !== '' &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '' &&
    !raw.includes('?') &&
    !raw.includes('#');
  if (!plain) {
    throw new ApiConfigError(
      'DREFYN_API_PUBLIC_URL',
      'must be an http or https origin with no path, query, fragment or user',
    );
  }
  return url.origin;
}

export function parseApiConfig(env: Env): ApiConfig {
  const port = take(
    env,
    'DREFYN_API_PORT',
    whole(0, 65_535),
    DEFAULT_PORT,
    'must be a whole number from 0 to 65535',
  );
  const host = take(
    env,
    'DREFYN_API_HOST',
    z.string().regex(/^[^\s]{1,253}$/),
    '127.0.0.1',
    'must be a host name or address',
  );
  const rawUrl = read(env, 'DREFYN_API_PUBLIC_URL');
  if (rawUrl === undefined && read(env, 'NODE_ENV') === 'production') {
    throw new ApiConfigError('DREFYN_API_PUBLIC_URL', 'is required in production');
  }
  const publicUrl = parsePublicUrl(rawUrl ?? `http://127.0.0.1:${String(port)}`);
  const maxBodyBytes = take(
    env,
    'DREFYN_API_MAX_BODY_BYTES',
    whole(1, MAX_BODY_BYTES),
    DEFAULT_BODY_BYTES,
    `must be a whole number from 1 to ${String(MAX_BODY_BYTES)}`,
  );
  const hops = take(
    env,
    'DREFYN_TRUSTED_PROXY_HOPS',
    whole(0, MAX_HOPS),
    0,
    `must be a whole number from 0 to ${String(MAX_HOPS)}`,
  );
  if (hops > 0 && LOOPBACK_NAMES.has(new URL(publicUrl).hostname)) {
    throw new ApiConfigError('DREFYN_TRUSTED_PROXY_HOPS', 'must be 0 for a loopback public URL');
  }
  const viewerHeader = take(
    env,
    'DREFYN_CLIENT_IP_HEADER',
    z.literal('cloudfront-viewer-address').transform(() => true),
    false,
    'must be cloudfront-viewer-address or unset',
  );
  if (viewerHeader && hops === 0) {
    throw new ApiConfigError(
      'DREFYN_CLIENT_IP_HEADER',
      'is read only from a trusted hop, so it needs hops of 1 or more',
    );
  }
  return { port, host, publicUrl, maxBodyBytes, hops, viewerHeader };
}

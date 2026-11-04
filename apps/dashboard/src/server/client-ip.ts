import type { IncomingHttpHeaders } from 'node:http';

// The client address and the forwarding headers Next sees. Next keeps a client supplied
// X-Forwarded-For and builds its own URLs from X-Forwarded-Host and -Proto, so the wrapper
// in front of it decides all of them from the socket, the declared proxy hops and the
// configured origin, and nothing a client sends survives.

export type Env = Readonly<Record<string, string | undefined>>;

export interface WrapperConfig {
  readonly origin: {
    readonly protocol: 'http' | 'https';
    // hostname plus a port only when it is not the scheme's default, as URL.host gives it.
    readonly host: string;
    readonly hostname: string;
    readonly port: string;
  };
  readonly hops: number;
  // Read CloudFront-Viewer-Address from the trusted hop instead of the chain.
  readonly viewerHeader: boolean;
}

export class WrapperConfigError extends Error {
  readonly key: string;

  // Fixed text only: a value may be a secret pasted into the wrong key.
  constructor(key: string, reason: string) {
    super(`${key} ${reason}`);
    this.key = key;
  }
}
Object.defineProperty(WrapperConfigError.prototype, 'name', { value: 'WrapperConfigError' });

const LOOPBACK_NAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_HOPS = 10;
const POOL_WANTED = 16;

// Compose passes an unset variable as an empty string.
function read(env: Env, key: string): string | undefined {
  const value = env[key];
  return value === undefined || value === '' ? undefined : value;
}

function parseOrigin(raw: string | undefined): WrapperConfig['origin'] {
  const reason = 'must be an http or https origin with no path, query, fragment or user';
  if (raw === undefined) throw new WrapperConfigError('DREFYN_APP_ORIGIN', 'is required');
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
  if (!plain) throw new WrapperConfigError('DREFYN_APP_ORIGIN', reason);
  const protocol = url.protocol === 'https:' ? 'https' : 'http';
  return {
    protocol,
    host: url.host,
    hostname: url.hostname,
    port: url.port === '' ? (protocol === 'https' ? '443' : '80') : url.port,
  };
}

// The same rules the auth settings apply to these keys, so the wrapper and auth can never
// disagree about who is trusted.
export function parseWrapperConfig(env: Env): WrapperConfig {
  const origin = parseOrigin(read(env, 'DREFYN_APP_ORIGIN'));
  const rawHops = read(env, 'DREFYN_TRUSTED_PROXY_HOPS');
  let hops = 0;
  if (rawHops !== undefined) {
    hops = /^[0-9]{1,2}$/.test(rawHops) ? Number(rawHops) : Number.NaN;
    if (!(hops >= 0 && hops <= MAX_HOPS)) {
      throw new WrapperConfigError(
        'DREFYN_TRUSTED_PROXY_HOPS',
        `must be a whole number from 0 to ${String(MAX_HOPS)}`,
      );
    }
  }
  // A loopback origin has nothing in front of it, so a forwarded address would be the
  // client's own claim.
  if (hops > 0 && LOOPBACK_NAMES.has(origin.hostname)) {
    throw new WrapperConfigError('DREFYN_TRUSTED_PROXY_HOPS', 'must be 0 for a loopback origin');
  }
  const header = read(env, 'DREFYN_CLIENT_IP_HEADER');
  if (header !== undefined && header !== 'cloudfront-viewer-address') {
    throw new WrapperConfigError(
      'DREFYN_CLIENT_IP_HEADER',
      'must be cloudfront-viewer-address or unset',
    );
  }
  if (header !== undefined && hops === 0) {
    throw new WrapperConfigError(
      'DREFYN_CLIENT_IP_HEADER',
      'is read only from a trusted hop, so it needs hops of 1 or more',
    );
  }
  return { origin, hops, viewerHeader: header !== undefined };
}

// The value read when the libuv pool is below what hashing needs, or null. libuv sizes the
// pool when it first starts, so it must be set before Node runs; the wrapper only reports.
export function smallThreadPool(env: Env): string | null {
  const raw = read(env, 'UV_THREADPOOL_SIZE');
  if (raw === undefined) return 'unset';
  const size = /^[0-9]{1,4}$/.test(raw) ? Number(raw) : Number.NaN;
  return size >= POOL_WANTED ? null : raw;
}

export const THREAD_POOL_WANTED = POOL_WANTED;

// Dotted decimal without leading zeros, which some parsers read as octal.
const OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])';
const IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`);
const GROUP = /^[0-9a-fA-F]{1,4}$/;

function groupsOf(part: string): number | null {
  if (part === '') return 0;
  const groups = part.split(':');
  return groups.every((g) => GROUP.test(g)) ? groups.length : null;
}

function isIpv6(text: string): boolean {
  let body = text;
  let tail = 0;
  if (text.includes('.')) {
    const cut = text.lastIndexOf(':');
    if (!IPV4.test(text.slice(cut + 1))) return false;
    tail = 2;
    body = text.slice(0, cut + 1);
    if (!body.endsWith('::')) body = body.slice(0, -1);
  }
  const halves = body.split('::');
  if (halves.length > 2) return false;
  const left = groupsOf(halves[0] ?? '');
  if (halves.length === 1) return left === 8 - tail;
  const right = groupsOf(halves[1] ?? '');
  if (left === null || right === null) return false;
  return left + right + tail < 8;
}

// A bare IPv4 or IPv6 literal, as given, or null. No brackets, ports or zone ids: a
// forwarding entry that needs any of those is not one this wrapper trusts.
export function parseIp(text: string): string | null {
  if (IPV4.test(text)) return text;
  return isIpv6(text) ? text : null;
}

// CloudFront writes the viewer as address:port, IPv6 included and unbracketed.
function viewerAddress(value: string): string | null {
  const cut = value.lastIndexOf(':');
  if (cut <= 0 || !/^[0-9]{1,5}$/.test(value.slice(cut + 1))) return null;
  return parseIp(value.slice(0, cut));
}

export interface ClientAddressInput {
  readonly socket: string;
  // X-Forwarded-For as Node gives it: repeated headers joined with ", ".
  readonly forwardedFor: string | undefined;
  readonly viewer: string | undefined;
}

export interface ResolvedAddress {
  readonly address: string;
  // The chain was shorter than the hops, or an entry a trusted hop wrote did not parse.
  readonly chainInvalid: boolean;
}

// With 0 hops the socket; with N hops the Nth entry from the right of
// [...X-Forwarded-For, socket]. Only the last N entries were written by proxies we trust, so
// a short or unparsable chain falls back to the left most of those, never further left.
export function resolveClientAddress(
  input: ClientAddressInput,
  config: WrapperConfig,
): ResolvedAddress {
  const { socket } = input;
  if (config.hops === 0) return { address: socket, chainInvalid: false };
  const entries =
    input.forwardedFor === undefined ? [] : input.forwardedFor.split(',').map((e) => e.trim());
  const chain = [...entries, socket];
  // A configured viewer header that is missing or garbled means the trusted hop is not the
  // one we were told about, so the chain answer below is flagged.
  let viewerMissing = false;
  if (config.viewerHeader) {
    const viewer = input.viewer === undefined ? null : viewerAddress(input.viewer.trim());
    if (viewer !== null) return { address: viewer, chainInvalid: false };
    viewerMissing = true;
  }
  const at = chain.length - 1 - config.hops;
  const trusted = Math.max(0, chain.length - config.hops);
  // Entries our own proxies wrote, between the candidate and the socket, must all parse.
  const hopsSound = chain.slice(trusted, -1).every((entry) => parseIp(entry) !== null);
  const candidate = at >= 0 && hopsSound ? parseIp(chain[at] ?? '') : null;
  if (candidate !== null) return { address: candidate, chainInvalid: viewerMissing };
  return { address: parseIp(chain[trusted] ?? '') ?? socket, chainInvalid: true };
}

// Every header a client could use to name its own address.
export const FORWARDING_HEADERS = Object.freeze([
  'x-forwarded-for',
  'forwarded',
  'x-real-ip',
  'cf-connecting-ip',
  'true-client-ip',
  'cloudfront-viewer-address',
] as const);

// Leaves exactly one X-Forwarded-For, the resolved address, and the host, scheme and port
// of the configured origin.
export function rewriteHeaders(
  headers: IncomingHttpHeaders,
  config: WrapperConfig,
  address: string,
): void {
  for (const name of FORWARDING_HEADERS) Reflect.deleteProperty(headers, name);
  headers['x-forwarded-for'] = address;
  headers['x-forwarded-host'] = config.origin.host;
  headers['x-forwarded-proto'] = config.origin.protocol;
  headers['x-forwarded-port'] = config.origin.port;
}

// The Host must name the origin: its host, or the hostname with the default port spelled out.
export function hostMatches(host: string | undefined, config: WrapperConfig): boolean {
  if (host === undefined) return false;
  const given = host.toLowerCase();
  const { origin } = config;
  return given === origin.host || given === `${origin.hostname}:${origin.port}`;
}

export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const given = host.toLowerCase();
  const name = given.startsWith('[') ? given.slice(0, given.indexOf(']') + 1) : given.split(':')[0];
  return LOOPBACK_NAMES.has(name ?? '');
}

// True at most once per interval on the given clock, so a misconfigured proxy logs a line a
// minute rather than one per request.
export function createThrottle(now: () => number, intervalMs = 60_000): () => boolean {
  let last = Number.NEGATIVE_INFINITY;
  return () => {
    const at = now();
    if (at - last < intervalMs) return false;
    last = at;
    return true;
  };
}

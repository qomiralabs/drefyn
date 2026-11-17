import { createHmac, randomBytes } from 'node:crypto';
import type { TenantRef } from '@drefyn/tenancy';

export type RateDecision =
  { readonly ok: true } | { readonly ok: false; readonly retryAfterSeconds: number };

// A port, so a host with several processes can back it with a shared store and get one count.
export interface RateLimiter {
  take(key: string): Promise<RateDecision>;
}

export interface MemoryRateLimiterOptions {
  readonly limit?: number;
  readonly windowMs?: number;
  // The most keys held at once. Past it the oldest window is dropped, which can only let that
  // client in early, never lock anyone out.
  readonly maxKeys?: number;
  readonly now?: () => number;
}

export const SEARCH_LIMIT_PER_MINUTE = 30;

interface Window {
  readonly startedAt: number;
  count: number;
}

const positiveInt = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError(`${name} must be a positive integer`);
  return value;
};

// Fixed windows per key, in memory.
export function createMemoryRateLimiter(options: MemoryRateLimiterOptions = {}): RateLimiter {
  const limit = positiveInt(options.limit ?? SEARCH_LIMIT_PER_MINUTE, 'limit');
  const windowMs = positiveInt(options.windowMs ?? 60_000, 'windowMs');
  const maxKeys = positiveInt(options.maxKeys ?? 100_000, 'maxKeys');
  const now = options.now ?? Date.now;
  const windows = new Map<string, Window>();

  return Object.freeze({
    take(key: string): Promise<RateDecision> {
      const at = now();
      let window = windows.get(key);
      if (window === undefined || at - window.startedAt >= windowMs) {
        windows.delete(key);
        window = { startedAt: at, count: 0 };
        windows.set(key, window);
        while (windows.size > maxKeys) {
          const oldest = windows.keys().next();
          if (oldest.done === true) break;
          windows.delete(oldest.value);
        }
      }
      if (window.count >= limit) {
        const left = windowMs - (at - window.startedAt);
        return Promise.resolve({
          ok: false,
          retryAfterSeconds: Math.max(1, Math.ceil(left / 1000)),
        });
      }
      window.count += 1;
      return Promise.resolve({ ok: true });
    },
  });
}

// Dotted decimal without leading zeros, which some parsers read as octal.
const OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])';
const IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`);
const IPV6_CHARS = /^[0-9A-Fa-f:.]{2,45}$/;

function expandIpv6(canonical: string): string[] {
  const [head = '', tail = ''] = canonical.split('::', 2);
  const left = head === '' ? [] : head.split(':');
  const right = tail === '' ? [] : tail.split(':');
  if (!canonical.includes('::')) return left;
  return [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
}

// The unit a client is counted as: an IPv4 address, or the /64 of an IPv6 one, since one host
// usually holds a whole /64. Null for anything that is not a bare address.
export function clientBucket(ip: string): string | null {
  if (IPV4.test(ip)) return ip;
  if (!IPV6_CHARS.test(ip) || !ip.includes(':')) return null;
  let host: string;
  try {
    // The URL parser validates and compresses IPv6, and writes an IPv4 tail as two groups.
    host = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const groups = expandIpv6(host);
  if (groups.length !== 8) return null;
  if (groups.slice(0, 5).every((g) => g === '0') && groups[5] === 'ffff') {
    const high = Number.parseInt(groups[6] ?? '0', 16);
    const low = Number.parseInt(groups[7] ?? '0', 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join('.');
  }
  return `${groups.slice(0, 4).join(':')}::/64`;
}

// Keys are HMACs under a secret held only in memory, so the limiter never holds an address.
export function createRateKeys(
  secret: Uint8Array = randomBytes(32),
): (tenant: TenantRef, ip: string) => string | null {
  return (tenant, ip) => {
    const bucket = clientBucket(ip);
    if (bucket === null) return null;
    return createHmac('sha256', secret)
      .update(`search:${tenant.organizationId}:${tenant.projectId}:${bucket}`)
      .digest('base64url');
  };
}

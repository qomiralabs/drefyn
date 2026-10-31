import { AuthError } from './errors.ts';

// The value a per IP limit is keyed by. An IPv6 host is usually given a whole /64, so keying
// by the full address would hand one person 2^64 buckets; IPv4 stays whole. One spelling per
// key, so two writings of one address can never land in two buckets.
export function rateKeyForIp(ip: string): string {
  const v4 = ipv4(ip);
  if (v4 !== null) return `ip4:${v4.join('.')}`;
  const groups = ipv6(ip);
  if (groups === null) throw new AuthError('AUTH_INPUT_INVALID');
  // ::ffff:a.b.c.d is an IPv4 client seen through a dual stack socket.
  const mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (mapped) {
    const [high = 0, low = 0] = groups.slice(6);
    return `ip4:${[high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')}`;
  }
  const prefix = groups.slice(0, 4).map((g) => g.toString(16).padStart(4, '0'));
  return `ip6:${prefix.join(':')}::/64`;
}

// Dotted decimal without leading zeros, which some parsers read as octal.
const OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])';
const IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`);
const GROUP = /^[0-9a-fA-F]{1,4}$/;

function ipv4(text: string): number[] | null {
  return IPV4.test(text) ? text.split('.').map(Number) : null;
}

function hexGroups(part: string): number[] | null {
  if (part === '') return [];
  const groups = part.split(':');
  return groups.every((g) => GROUP.test(g)) ? groups.map((g) => parseInt(g, 16)) : null;
}

// Eight 16 bit groups, or null. Zone ids (%eth0) name a local interface and are refused by
// the group pattern.
function ipv6(text: string): number[] | null {
  let body = text;
  let tail: number[] = [];
  if (text.includes('.')) {
    // A dotted IPv4 tail fills the last two groups.
    const cut = text.lastIndexOf(':');
    const v4 = ipv4(text.slice(cut + 1));
    if (v4 === null) return null;
    const [a = 0, b = 0, c = 0, d = 0] = v4;
    tail = [(a << 8) | b, (c << 8) | d];
    body = text.slice(0, cut + 1);
    if (!body.endsWith('::')) body = body.slice(0, -1);
  }
  const want = 8 - tail.length;
  const halves = body.split('::');
  if (halves.length > 2) return null;
  const [head = '', rest] = halves;
  const left = hexGroups(head);
  if (rest === undefined) {
    return left !== null && left.length === want ? [...left, ...tail] : null;
  }
  const right = hexGroups(rest);
  if (left === null || right === null) return null;
  const missing = want - left.length - right.length;
  // :: stands for at least one group.
  if (missing < 1) return null;
  return [...left, ...Array<number>(missing).fill(0), ...right, ...tail];
}

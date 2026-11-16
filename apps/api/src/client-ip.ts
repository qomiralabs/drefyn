// The address a request's failures are counted against. Only the socket and the entries our
// own proxies wrote are trusted; anything further left in X-Forwarded-For is the client's claim.
// The same rules the dashboard's wrapper applies, so one client gets one bucket in both.

export interface TrustedHops {
  readonly hops: number;
  readonly viewerHeader: boolean;
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

// A bare IPv4 or IPv6 literal, as given, or null. No brackets, ports or zone ids.
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

// With 0 hops the socket; with N hops the Nth entry from the right of
// [...X-Forwarded-For, socket]. A short or unparsable chain falls back to the left most entry
// our proxies wrote, never further left.
export function resolveClientAddress(
  input: ClientAddressInput,
  config: TrustedHops,
): ResolvedAddress {
  const { socket } = input;
  if (config.hops === 0) return { address: socket, chainInvalid: false };
  const entries =
    input.forwardedFor === undefined ? [] : input.forwardedFor.split(',').map((e) => e.trim());
  const chain = [...entries, socket];
  let viewerMissing = false;
  if (config.viewerHeader) {
    const viewer = input.viewer === undefined ? null : viewerAddress(input.viewer.trim());
    if (viewer !== null) return { address: viewer, chainInvalid: false };
    viewerMissing = true;
  }
  const at = chain.length - 1 - config.hops;
  const trusted = Math.max(0, chain.length - config.hops);
  const hopsSound = chain.slice(trusted, -1).every((entry) => parseIp(entry) !== null);
  const candidate = at >= 0 && hopsSound ? parseIp(chain[at] ?? '') : null;
  if (candidate !== null) return { address: candidate, chainInvalid: viewerMissing };
  return { address: parseIp(chain[trusted] ?? '') ?? socket, chainInvalid: true };
}

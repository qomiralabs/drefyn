import { BlockList, isIP } from 'node:net';
import type { AddressClass } from './types.ts';

// Node's own parser (the one net.connect uses) decides what is an address, so the text
// that is checked is read exactly as the text that is dialled. Anything it does not
// accept as written, such as 0x7f.1 or 127.1, is not an address here; WHATWG URL folds
// those to dotted form before they get this far.

type Family = 'ipv4' | 'ipv6';
type Range = readonly [AddressClass, string, number];

// First match wins, so a narrow range sits before any wider one that holds it.
const V4_RANGES: readonly Range[] = [
  ['unspecified', '0.0.0.0', 8],
  ['private', '10.0.0.0', 8],
  ['carrierGradeNat', '100.64.0.0', 10],
  ['loopback', '127.0.0.0', 8],
  ['linkLocal', '169.254.0.0', 16],
  ['private', '172.16.0.0', 12],
  ['documentation', '192.0.2.0', 24],
  ['reserved', '192.0.0.0', 24],
  // The old 6to4 relay anycast block.
  ['reserved', '192.88.99.0', 24],
  ['private', '192.168.0.0', 16],
  ['benchmarking', '198.18.0.0', 15],
  ['documentation', '198.51.100.0', 24],
  ['documentation', '203.0.113.0', 24],
  ['multicast', '224.0.0.0', 4],
  ['broadcast', '255.255.255.255', 32],
  ['reserved', '240.0.0.0', 4],
];

// Every IPv6 block that wraps or routes to an IPv4 address is refused whole, except the
// mapped block, which is judged by the IPv4 address inside it.
const V6_RANGES: readonly Range[] = [
  ['unspecified', '::', 128],
  ['loopback', '::1', 128],
  ['ipv4Compatible', '::', 96],
  ['rfc6052', '64:ff9b::', 96],
  ['rfc8215', '64:ff9b:1::', 48],
  ['discard', '100::', 64],
  ['teredo', '2001::', 32],
  ['reserved', '2001::', 23],
  ['documentation', '2001:db8::', 32],
  ['6to4', '2002::', 16],
  ['documentation', '3fff::', 20],
  ['uniqueLocal', 'fc00::', 7],
  ['linkLocal', 'fe80::', 10],
  ['siteLocal', 'fec0::', 10],
  ['multicast', 'ff00::', 8],
];

function compile(ranges: readonly Range[], family: Family) {
  return ranges.map(([addressClass, network, prefix]) => {
    const list = new BlockList();
    list.addSubnet(network, prefix, family);
    return [addressClass, list] as const;
  });
}

const V4 = compile(V4_RANGES, 'ipv4');
const V6 = compile(V6_RANGES, 'ipv6');
const MAPPED = compile([['unicast', '::ffff:0:0', 96]], 'ipv6');
const GLOBAL_UNICAST = compile([['unicast', '2000::', 3]], 'ipv6');

function firstMatch(
  table: readonly (readonly [AddressClass, BlockList])[],
  address: string,
  family: Family,
): AddressClass | undefined {
  return table.find(([, list]) => list.check(address, family))?.[0];
}

export interface AddressVerdict {
  readonly family: 4 | 6;
  /** 'unicast' is the only class a public policy lets through. */
  readonly addressClass: AddressClass;
}

export function classifyAddress(address: string): AddressVerdict | undefined {
  const family = isIP(address);
  if (family === 4) {
    return { family, addressClass: firstMatch(V4, address, 'ipv4') ?? 'unicast' };
  }
  if (family !== 6) return undefined;
  // A zone ties the address to one interface of this host, whatever the address says.
  if (address.includes('%')) return { family, addressClass: 'scoped' };
  if (firstMatch(MAPPED, address, 'ipv6') !== undefined) {
    // BlockList matches IPv4 rules against the IPv4 address inside a mapped one.
    return { family, addressClass: firstMatch(V4, address, 'ipv6') ?? 'unicast' };
  }
  const denied = firstMatch(V6, address, 'ipv6');
  if (denied !== undefined) return { family, addressClass: denied };
  return {
    family,
    addressClass: firstMatch(GLOBAL_UNICAST, address, 'ipv6') ?? 'reserved',
  };
}

export interface PrivateAllowList {
  has(address: string): boolean;
}

const CIDR = /^([^/]+)\/(\d{1,3})$/;

const compiled = new WeakMap<readonly string[], PrivateAllowList>();

/** Throws a TypeError on a malformed range: the list comes from code or config, not customers. */
export function privateAllowList(cidrs: readonly string[]): PrivateAllowList {
  const known = compiled.get(cidrs);
  if (known !== undefined) return known;
  const made = compileAllowList(cidrs);
  compiled.set(cidrs, made);
  return made;
}

function compileAllowList(cidrs: readonly string[]): PrivateAllowList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const match = CIDR.exec(cidr);
    const network = match?.[1] ?? '';
    const prefix = Number(match?.[2]);
    const family = isIP(network);
    if (family === 0 || prefix > (family === 4 ? 32 : 128) || network.includes('%')) {
      throw new TypeError(`egress: ${JSON.stringify(cidr)} is not an address range`);
    }
    list.addSubnet(network, prefix, family === 4 ? 'ipv4' : 'ipv6');
  }
  return {
    has: (address) => {
      const family = isIP(address);
      if (family === 0 || address.includes('%')) return false;
      return list.check(address, family === 4 ? 'ipv4' : 'ipv6');
    },
  };
}

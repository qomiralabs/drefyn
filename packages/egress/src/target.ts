import { isIP } from 'node:net';
import { classifyAddress, privateAllowList } from './address.ts';
import type { AddressClass, CheckedAddress, EgressError, EgressPolicy, Result } from './types.ts';

// Everything that can be decided before DNS: the URL shape, scheme, port, names that only
// mean something inside a network, and address literals. WHATWG URL does the parsing, so
// 0x7f.1, 2130706433 and the rest arrive here already folded to dotted form.

export interface Target {
  readonly url: URL;
  /** A name or an address, without brackets or a trailing dot. */
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
  /** Set when the URL names an address; it is already checked. */
  readonly literal: CheckedAddress | undefined;
}

export interface CheckedHost {
  readonly host: string;
  readonly literal: CheckedAddress | undefined;
}

const DEFAULT_PORT = { 'http:': 80, 'https:': 443 } as const;
const DENIED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];
const MAX_NAME = 253;
const MAX_LABEL = 63;

const failure = (error: EgressError) => ({ ok: false, error }) as const;

/**
 * Undefined when the text is not an address. Otherwise public unicast passes, and so does
 * an address inside a range the policy lists; everything else is refused with its class.
 */
export function admitAddress(
  address: string,
  policy: EgressPolicy,
):
  | { readonly ok: true; readonly value: CheckedAddress }
  | { readonly ok: false; readonly addressClass: AddressClass }
  | undefined {
  const verdict = classifyAddress(address);
  if (verdict === undefined) return undefined;
  const allowed =
    verdict.addressClass === 'unicast' ||
    (policy.allowPrivate !== false && privateAllowList(policy.allowPrivate.cidrs).has(address));
  if (!allowed) return { ok: false, addressClass: verdict.addressClass };
  return { ok: true, value: { address, family: verdict.family } };
}

function deniedName(name: string): boolean {
  return (
    name === 'localhost' ||
    !name.includes('.') ||
    DENIED_SUFFIXES.some((suffix) => name.endsWith(suffix))
  );
}

/** Checks the host part of a parsed URL: a bracketed IPv6, a dotted IPv4, or a name. */
export function checkHost(
  hostname: string,
  policy: EgressPolicy,
  hop: number,
): Result<CheckedHost, EgressError> {
  const bare =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const admitted = admitAddress(bare, policy);
  if (admitted !== undefined) {
    if (!admitted.ok) {
      return failure({ code: 'egress.address_denied', hop, addressClass: admitted.addressClass });
    }
    return { ok: true, value: { host: bare, literal: admitted.value } };
  }
  const name = bare.endsWith('.') ? bare.slice(0, -1) : bare;
  const labels = name.split('.');
  if (
    name.length === 0 ||
    name.length > MAX_NAME ||
    labels.some((label) => label.length === 0 || label.length > MAX_LABEL)
  ) {
    return failure({ code: 'egress.url_invalid', hop });
  }
  // A private policy may name hosts on its own network, so only a public one refuses these.
  if (policy.allowPrivate === false && deniedName(name)) {
    return failure({ code: 'egress.host_denied', hop });
  }
  return { ok: true, value: { host: name, literal: undefined } };
}

export function checkTarget(
  raw: string,
  policy: EgressPolicy,
  hop = 0,
): Result<Target, EgressError> {
  const url = URL.parse(raw);
  if (url === null) return failure({ code: 'egress.url_invalid', hop });
  const scheme = url.protocol.slice(0, -1);
  if (!(policy.schemes as readonly string[]).includes(scheme)) {
    return failure({ code: 'egress.scheme_denied', hop });
  }
  // Userinfo exists to make a URL read as one host while it goes to another.
  if (url.username !== '' || url.password !== '') {
    return failure({ code: 'egress.url_invalid', hop });
  }
  const port =
    url.port === '' ? DEFAULT_PORT[url.protocol as keyof typeof DEFAULT_PORT] : Number(url.port);
  if (port === 0 || (policy.ports !== 'any' && !policy.ports.includes(port))) {
    return failure({ code: 'egress.port_denied', hop });
  }
  const host = checkHost(url.hostname, policy, hop);
  if (!host.ok) return host;
  return {
    ok: true,
    value: {
      url,
      host: host.value.host,
      port,
      tls: url.protocol === 'https:',
      literal: host.value.literal,
    },
  };
}

const NOT_IN_A_HOST = /[\s/?#@\\]/;

/** Reads a bare host, as given to guardedConnect or guardedResolve, through the same rules. */
export function checkBareHost(raw: string, policy: EgressPolicy): Result<CheckedHost, EgressError> {
  const bracketed = isIP(raw) === 6 ? `[${raw}]` : raw;
  if (raw === '' || NOT_IN_A_HOST.test(raw) || /:(?![^[]*\])/.test(bracketed)) {
    return failure({ code: 'egress.url_invalid', hop: 0 });
  }
  const url = URL.parse(`http://${bracketed}/`);
  if (url === null) return failure({ code: 'egress.url_invalid', hop: 0 });
  return checkHost(url.hostname, policy, 0);
}

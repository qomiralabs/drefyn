export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export type EgressPurpose =
  'monitor' | 'webhook' | 'feed' | 'import' | 'spec_fetch' | 'try_it' | 'media_import';

export interface EgressPolicy {
  readonly purpose: EgressPurpose;
  /** Only private probes and self hosted installs pass a list; everyone else gets false. */
  readonly allowPrivate: false | { readonly cidrs: readonly string[] };
  readonly schemes: readonly ('https' | 'http')[];
  readonly ports: 'any' | readonly number[];
  readonly maxRedirects: 0 | 1 | 2 | 3 | 4 | 5;
  readonly connectTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly maxResponseBytes: number;
}

export type EgressErrorCode =
  | 'egress.url_invalid'
  | 'egress.scheme_denied'
  // localhost, .localhost, .local, .internal, .home.arpa and single label names
  | 'egress.host_denied'
  // resolved to, or written as, an address that is not public unicast and not allowed
  | 'egress.address_denied'
  | 'egress.port_denied'
  | 'egress.dns_failed'
  | 'egress.connect_timeout'
  // refused, reset, TLS failure or a broken response; cause holds the system code
  | 'egress.network_failed'
  | 'egress.timeout'
  // the caller's signal fired
  | 'egress.aborted'
  | 'egress.too_large'
  | 'egress.too_many_redirects';

export interface EgressError {
  readonly code: EgressErrorCode;
  /** 0 for the first request, then one more for each redirect followed. */
  readonly hop: number;
  readonly addressClass?: AddressClass;
  /** A Node or OpenSSL error code such as ECONNREFUSED, never a message or content. */
  readonly cause?: string;
}

export type AddressClass =
  | 'unicast'
  | 'unspecified'
  | 'private'
  | 'carrierGradeNat'
  | 'loopback'
  | 'linkLocal'
  | 'reserved'
  | 'documentation'
  | 'benchmarking'
  | 'multicast'
  | 'broadcast'
  | 'ipv4Compatible'
  | 'rfc6052'
  | 'rfc8215'
  | 'discard'
  | 'teredo'
  | '6to4'
  | 'uniqueLocal'
  | 'siteLocal'
  | 'scoped';

export interface CheckedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface GuardedRequestInit {
  readonly method?: string;
  /** Host, Content-Length, Connection and the other framing headers are set by the guard. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
  readonly signal?: AbortSignal;
}

export interface GuardedResponse {
  readonly status: number;
  readonly headers: Headers;
  /** As sent on the wire: nothing is decompressed, so the size cap is the real cost. */
  readonly body: Uint8Array;
  /** The URL that answered, after any redirects. */
  readonly url: string;
  readonly redirects: number;
  /** The checked address the last request was sent to. */
  readonly address: CheckedAddress;
}

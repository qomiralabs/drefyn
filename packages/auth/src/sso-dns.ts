import { Resolver } from 'node:dns/promises';

// What a TXT lookup can say. unknown is a lookup that got no answer (a timeout, a server
// failure, a refused query): it says nothing about the record, so it must never count
// against a domain. A name with no records is an answer, just an empty one.
export type TxtLookup =
  { readonly kind: 'answer'; readonly records: readonly string[] } | { readonly kind: 'unknown' };

export interface TxtResolver {
  // Never throws for a DNS failure; every failure is unknown.
  lookupTxt(name: string): Promise<TxtLookup>;
}

// The part of node:dns this needs, so tests can stand in for the network.
export interface DnsBackend {
  resolveTxt(name: string): Promise<string[][]>;
  cancel(): void;
}

export interface NodeTxtResolverOptions {
  readonly timeoutMs: number;
  // The resolvers to ask, as host or host:port. Unset means the ones the host is set up with.
  readonly servers?: readonly string[];
  readonly backend?: (options: BackendOptions) => DnsBackend;
}

interface BackendOptions {
  readonly timeoutMs: number;
  readonly servers?: readonly string[];
}

// A domain owner chooses how many records answer, so only this many are read.
const MAX_RECORDS = 64;
const MAX_RECORD_CHARS = 4096;
const MAX_TIMEOUT_MS = 60_000;
// The name exists and holds no TXT record, or the name does not exist at all.
const ANSWERED_EMPTY: ReadonlySet<unknown> = new Set(['ENODATA', 'ENOTFOUND']);

function nodeBackend(options: BackendOptions): DnsBackend {
  // One try: the overall timeout below is the budget, and a retry inside it would only
  // stretch one slow server over the whole of it.
  const resolver = new Resolver({ timeout: options.timeoutMs, tries: 1 });
  if (options.servers !== undefined) resolver.setServers([...options.servers]);
  return {
    resolveTxt: (name) => resolver.resolveTxt(name),
    cancel: () => {
      resolver.cancel();
    },
  };
}

export function createNodeTxtResolver(options: NodeTxtResolverOptions): TxtResolver {
  const { timeoutMs } = options;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError('TXT lookup timeout must be a whole number of ms from 1 to 60000');
  }
  const makeBackend = options.backend ?? nodeBackend;
  return Object.freeze({
    async lookupTxt(name: string): Promise<TxtLookup> {
      // A resolver per lookup, so cancelling one never cancels another in flight.
      const backend = makeBackend(
        options.servers === undefined ? { timeoutMs } : { timeoutMs, servers: options.servers },
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => {
          resolve('timeout');
        }, timeoutMs);
      });
      try {
        const answer = await Promise.race([backend.resolveTxt(name), timedOut]);
        if (answer === 'timeout') {
          backend.cancel();
          return { kind: 'unknown' };
        }
        const records = answer
          .slice(0, MAX_RECORDS)
          .map((chunks) => chunks.join(''))
          .filter((record) => record.length <= MAX_RECORD_CHARS);
        return { kind: 'answer', records };
      } catch (error) {
        const code: unknown = Reflect.get(Object(error), 'code');
        return ANSWERED_EMPTY.has(code) ? { kind: 'answer', records: [] } : { kind: 'unknown' };
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

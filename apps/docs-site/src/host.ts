import { idOf, type TenantRef } from '@drefyn/tenancy';
import { z } from 'zod';
import { isAtOrUnder, isHostname } from './hostname.ts';
import type { DocsLogger } from './log.ts';

declare const siteBrand: unique symbol;
export type SiteId = string & { readonly [siteBrand]: 'site' };

// Previews get their own kind with the preview host; until then nothing else resolves.
export type HostResolution =
  | { kind: 'site'; tenant: TenantRef; siteId: SiteId; access: 'public' | 'private' }
  | { kind: 'unknown' };

export interface SiteDomains {
  // Default hosts are <name>.<hostSuffix>, one label only.
  readonly hostSuffix: string;
  // Nothing at or under this resolves except a default host, so a custom domain row can never
  // claim one of our own names.
  readonly reservedDomain: string;
  // Never serves customer content, nor does anything under it.
  readonly dashboardHost: string;
}

// Where hosts are looked up. Answers a record for exactly the name asked, or null. The
// resolver checks every answer again, so a directory bug cannot hand out another tenant.
export interface SiteDirectory {
  bySubdomain(subdomain: string, signal: AbortSignal): Promise<unknown>;
  byCustomDomain(domain: string, signal: AbortSignal): Promise<unknown>;
}

export type HostLookupCode =
  'site.directory_failed' | 'site.directory_timeout' | 'site.directory_invalid';

export class HostLookupError extends Error {
  readonly code: HostLookupCode;
  constructor(code: HostLookupCode) {
    super(code);
    this.name = 'HostLookupError';
    this.code = code;
  }
}

export interface HostResolverOptions {
  readonly domains: SiteDomains;
  readonly directory: SiteDirectory;
  readonly logger?: DocsLogger;
  readonly maxEntries?: number;
  readonly ttlMs?: number;
  readonly unknownTtlMs?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export interface HostResolver {
  resolveHost(host: string): Promise<HostResolution>;
}

// Names under the suffix that are ours: status pages, previews and the bare www.
const RESERVED_LABELS: ReadonlySet<string> = new Set(['status', 'preview', 'www']);

const HOST_HEADER = /^([a-z0-9.-]+)(?::([0-9]{1,5}))?$/;

// The Host header as one name, or null when it is not a plain DNS name. A trailing dot, an
// address, userinfo or a list all count as not a host, so each name has one spelling and one
// cache entry.
export function normalizeHost(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null || raw.length > 259) return null;
  const match = HOST_HEADER.exec(raw.toLowerCase());
  if (match === null) return null;
  const [, name = '', port] = match;
  if (port !== undefined && Number(port) > 65_535) return null;
  return isHostname(name) ? name : null;
}

const uuid = z.string().refine((value) => {
  try {
    idOf('org', value);
    return true;
  } catch {
    return false;
  }
});

const siteFields = {
  organizationId: uuid,
  projectId: uuid,
  siteId: uuid,
  access: z.enum(['public', 'private']),
};

const subdomainRecord = z.object({ subdomain: z.string(), ...siteFields });
const customDomainRecord = z.object({
  domain: z.string(),
  ...siteFields,
  verifiedAt: z.date().nullable(),
  detachedAt: z.date().nullable(),
});

type SiteFields = z.infer<z.ZodObject<typeof siteFields>>;

const UNKNOWN: HostResolution = Object.freeze({ kind: 'unknown' });

const site = (record: SiteFields): HostResolution => ({
  kind: 'site',
  tenant: {
    organizationId: idOf('org', record.organizationId),
    projectId: idOf('prj', record.projectId),
  },
  siteId: record.siteId as SiteId,
  access: record.access,
});

interface Entry {
  readonly at: number;
  readonly value: Promise<HostResolution>;
  // Set once the lookup answers; until then requests share the one in flight.
  answer?: HostResolution;
}

function positiveInteger(name: string, value: number, min: number): number {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`${name} must be an integer of at least ${String(min)}`);
  }
  return value;
}

export function createHostResolver(options: HostResolverOptions): HostResolver {
  const { domains, directory, logger } = options;
  const maxEntries = positiveInteger('maxEntries', options.maxEntries ?? 10_000, 1);
  // A detached domain keeps serving for at most this long.
  const ttlMs = positiveInteger('ttlMs', options.ttlMs ?? 30_000, 0);
  // Short, so a site created a moment ago is not a 404 for long.
  const unknownTtlMs = positiveInteger('unknownTtlMs', options.unknownTtlMs ?? 5_000, 0);
  const timeoutMs = positiveInteger('timeoutMs', options.timeoutMs ?? 1_000, 1);
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();

  // Bounded by timeoutMs whether or not the directory honours the signal.
  async function ask(work: (signal: AbortSignal) => Promise<unknown>): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new HostLookupError('site.directory_timeout'));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        work(controller.signal).catch((error: unknown) => {
          if (controller.signal.aborted) throw new HostLookupError('site.directory_timeout');
          throw error instanceof HostLookupError
            ? error
            : new HostLookupError('site.directory_failed');
        }),
        timedOut,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function lookup(name: string): Promise<HostResolution> {
    if (isAtOrUnder(name, domains.dashboardHost)) return UNKNOWN;
    if (name.endsWith(`.${domains.hostSuffix}`)) {
      const label = name.slice(0, -domains.hostSuffix.length - 1);
      if (label.includes('.') || RESERVED_LABELS.has(label)) return UNKNOWN;
      const found = await ask((signal) => directory.bySubdomain(label, signal));
      if (found === null) return UNKNOWN;
      const record = subdomainRecord.safeParse(found);
      if (!record.success || record.data.subdomain !== label) {
        throw new HostLookupError('site.directory_invalid');
      }
      return site(record.data);
    }
    if (isAtOrUnder(name, domains.reservedDomain) || name === domains.hostSuffix) return UNKNOWN;
    const found = await ask((signal) => directory.byCustomDomain(name, signal));
    if (found === null) return UNKNOWN;
    const record = customDomainRecord.safeParse(found);
    if (!record.success || record.data.domain !== name) {
      throw new HostLookupError('site.directory_invalid');
    }
    // Only a domain whose ownership was proved, and that has not lost it since.
    if (record.data.verifiedAt === null || record.data.detachedAt !== null) return UNKNOWN;
    return site(record.data);
  }

  return {
    async resolveHost(host) {
      const name = normalizeHost(host);
      if (name === null) return UNKNOWN;
      const at = now();
      const hit = entries.get(name);
      if (hit !== undefined) {
        const life = hit.answer?.kind === 'site' ? ttlMs : unknownTtlMs;
        if (hit.answer === undefined || at - hit.at < life) {
          // Moved to the back, so the oldest entry is always the least recently used.
          entries.delete(name);
          entries.set(name, hit);
          return hit.value;
        }
      }
      const entry: Entry = { at, value: lookup(name) };
      entries.delete(name);
      entries.set(name, entry);
      entry.value.then(
        (answer) => {
          entry.answer = answer;
        },
        (error: unknown) => {
          // A failure is not kept, so the next request asks again.
          if (entries.get(name) === entry) entries.delete(name);
          const code = error instanceof HostLookupError ? error.code : 'site.directory_failed';
          logger?.error(code, { code });
        },
      );
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
      return entry.value;
    },
  };
}

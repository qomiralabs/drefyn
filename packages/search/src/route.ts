import { toPublicId, type TenantRef } from '@drefyn/tenancy';
import { noopLogger, type LogFields, type SearchLogger } from './log.ts';
import { createRateKeys, type RateLimiter } from './limiter.ts';
import { parseSearchPin } from './pin.ts';
import { parseSearchQuery } from './query.ts';
import type { PublishedSearch } from './search.ts';

// Which site a host serves. Only verified domains resolve; anything else is null and reads as
// a site that does not exist.
export interface SiteResolver {
  resolve(host: string): Promise<TenantRef | null>;
}

export const SEARCH_ERROR_CODES = [
  'search.query_invalid',
  'search.not_found',
  'search.method_not_allowed',
  'search.rate_limited',
  'search.unavailable',
] as const;

export type SearchErrorCode = (typeof SEARCH_ERROR_CODES)[number];

const ERRORS: Readonly<Record<SearchErrorCode, { status: number; message: string }>> = {
  'search.query_invalid': {
    status: 400,
    message: 'Search needs one q parameter of up to 256 bytes, and a valid version and locale.',
  },
  'search.not_found': { status: 404, message: 'There is no site here.' },
  'search.method_not_allowed': { status: 405, message: 'Search only answers GET.' },
  'search.rate_limited': { status: 429, message: 'Too many searches. Try again shortly.' },
  'search.unavailable': {
    status: 503,
    message: 'Search is unavailable right now. The pages still work.',
  },
};

const BASE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const;

function errorResponse(code: SearchErrorCode, extra: Record<string, string> = {}): Response {
  const { status, message } = ERRORS[code];
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { ...BASE_HEADERS, ...extra },
  });
}

export interface SearchRouteDeps {
  readonly sites: SiteResolver;
  readonly search: PublishedSearch;
  readonly limiter: RateLimiter;
  readonly logger?: SearchLogger;
  // HMAC secret for limiter keys. Random per process when missing.
  readonly rateKeySecret?: Uint8Array;
}

// The address comes from the host, which resolved it from the socket and its own trusted
// proxies. The request's own headers are never read for it here.
export type SearchRoute = (request: Request, clientIp: string) => Promise<Response>;

const ONE_VALUE = (params: URLSearchParams, name: string): string | undefined | null => {
  const all = params.getAll(name);
  if (all.length === 0) return undefined;
  return all.length === 1 ? (all[0] ?? null) : null;
};

// GET /api/search?q=&version=&locale= on a site host. No parameter the reader sends reaches
// Typesense except the query text; the filter, collection and key are built here.
export function createSearchRoute(deps: SearchRouteDeps): SearchRoute {
  const logger = deps.logger ?? noopLogger;
  const rateKey = createRateKeys(deps.rateKeySecret);

  return async (request, clientIp) => {
    const started = performance.now();
    const fields: Record<string, string | number | boolean> = {};
    const done = (response: Response): Response => {
      const line: LogFields = {
        ...fields,
        status: response.status,
        durationMs: Math.round(performance.now() - started),
      };
      if (response.status >= 500) logger.warn('search.request', line);
      else logger.info('search.request', line);
      return response;
    };

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return done(errorResponse('search.method_not_allowed', { allow: 'GET, HEAD' }));
    }
    const url = new URL(request.url);
    let tenant: TenantRef | null;
    try {
      tenant = await deps.sites.resolve(url.hostname);
    } catch {
      fields['reason'] = 'site_lookup';
      return done(errorResponse('search.unavailable'));
    }
    if (tenant === null) return done(errorResponse('search.not_found'));
    fields['organizationId'] = toPublicId('org', tenant.organizationId);
    fields['projectId'] = toPublicId('prj', tenant.projectId);

    const key = rateKey(tenant, clientIp);
    if (key === null) {
      fields['reason'] = 'client_address';
      return done(errorResponse('search.unavailable'));
    }
    let decision;
    try {
      decision = await deps.limiter.take(key);
    } catch {
      fields['reason'] = 'limiter';
      return done(errorResponse('search.unavailable'));
    }
    if (!decision.ok) {
      return done(
        errorResponse('search.rate_limited', { 'retry-after': String(decision.retryAfterSeconds) }),
      );
    }

    const q = ONE_VALUE(url.searchParams, 'q');
    const version = ONE_VALUE(url.searchParams, 'version');
    const locale = ONE_VALUE(url.searchParams, 'locale');
    const query = parseSearchQuery(q);
    const pin = version === null || locale === null ? null : parseSearchPin({ version, locale });
    if (!query.ok || pin === null) {
      fields['reason'] = query.ok ? 'pin' : query.reason;
      return done(errorResponse('search.query_invalid'));
    }
    fields['version'] = pin.version;
    fields['locale'] = pin.locale;

    const result = await deps.search.searchPublished(tenant, pin, query.query);
    if (!result.ok) {
      fields['reason'] = result.error.reason;
      return done(errorResponse('search.unavailable'));
    }
    fields['hits'] = result.value.hits.length;
    fields['typesenseMs'] = result.value.typesenseMs;
    const body = request.method === 'HEAD' ? null : JSON.stringify({ hits: result.value.hits });
    return done(new Response(body, { status: 200, headers: BASE_HEADERS }));
  };
}

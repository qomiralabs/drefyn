import { toPublicId, type TenantRef } from '@drefyn/tenancy';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createMemoryRateLimiter, type RateLimiter } from '../src/limiter.ts';
import type { SearchPin } from '../src/pin.ts';
import type { SearchQuery } from '../src/query.ts';
import { createSearchRoute, type SiteResolver } from '../src/route.ts';
import type { PublishedSearch, SearchResult } from '../src/search.ts';
import { captureLogger, TENANT_A } from './support.ts';

const HOST = 'docs.example.com';
const IP = '203.0.113.9';

const sites: SiteResolver = {
  resolve: (host) => Promise.resolve(host === HOST ? TENANT_A : null),
};

interface Recorded {
  tenant: TenantRef;
  pin: SearchPin;
  query: SearchQuery;
}

function fakeSearch(result: SearchResult = { ok: true, value: { hits: [], typesenseMs: 3 } }) {
  const seen: Recorded[] = [];
  const search: PublishedSearch = {
    searchPublished: (tenant, pin, query) => {
      seen.push({ tenant, pin, query });
      return Promise.resolve(result);
    },
  };
  return { search, seen };
}

const get = (path: string, init: RequestInit = {}) => new Request(`https://${HOST}${path}`, init);

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } };
  return body.error.code;
}

describe('createSearchRoute', () => {
  it('answers a search with hits, no caching and the pin it read', async () => {
    const hits = [
      { nodeId: 'nod_x', path: '/a', title: 'A', excerpt: [{ text: 'a', match: true }] },
    ];
    const { search, seen } = fakeSearch({ ok: true, value: { hits, typesenseMs: 4 } });
    const route = createSearchRoute({ sites, search, limiter: createMemoryRateLimiter() });
    const response = await route(get('/api/search?q=install&version=v2&locale=en-gb'), IP);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.json()).toEqual({ hits });
    expect(seen).toEqual([
      { tenant: TENANT_A, pin: { version: 'v2', locale: 'en-GB' }, query: 'install' },
    ]);
  });

  it('answers HEAD with headers only', async () => {
    const route = createSearchRoute({
      sites,
      search: fakeSearch().search,
      limiter: createMemoryRateLimiter(),
    });
    const response = await route(get('/api/search?q=a', { method: 'HEAD' }), IP);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });

  it('refuses other methods', async () => {
    const route = createSearchRoute({
      sites,
      search: fakeSearch().search,
      limiter: createMemoryRateLimiter(),
    });
    const response = await route(get('/api/search?q=a', { method: 'POST', body: '{}' }), IP);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
    expect(await errorCode(response)).toBe('search.method_not_allowed');
  });

  it('reads an unknown host as no site', async () => {
    const { search, seen } = fakeSearch();
    const route = createSearchRoute({ sites, search, limiter: createMemoryRateLimiter() });
    const response = await route(new Request('https://other.example/api/search?q=a'), IP);
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe('search.not_found');
    expect(seen).toHaveLength(0);
  });

  it.each([
    ['/api/search'],
    ['/api/search?q='],
    ['/api/search?q=a&q=b'],
    [`/api/search?q=${'a'.repeat(257)}`],
    ['/api/search?q=a&version=V1'],
    ['/api/search?q=a&version=v1&version=v2'],
    ['/api/search?q=a&locale=en_US'],
    ['/api/search?q=a&locale=en&locale=fr'],
  ])('refuses %s with 400', async (path) => {
    const { search, seen } = fakeSearch();
    const route = createSearchRoute({ sites, search, limiter: createMemoryRateLimiter() });
    const response = await route(get(path), IP);
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('search.query_invalid');
    expect(seen).toHaveLength(0);
  });

  it('returns 429 with Retry-After past 30 a minute from one client, before touching search', async () => {
    const { search, seen } = fakeSearch();
    const route = createSearchRoute({
      sites,
      search,
      limiter: createMemoryRateLimiter({ now: () => 0 }),
    });
    for (let i = 0; i < 30; i += 1)
      expect((await route(get('/api/search?q=a'), IP)).status).toBe(200);
    const limited = await route(get('/api/search?q=a'), IP);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect(await errorCode(limited)).toBe('search.rate_limited');
    expect(seen).toHaveLength(30);
    // Another client still gets through.
    expect((await route(get('/api/search?q=a'), '198.51.100.1')).status).toBe(200);
  });

  it('returns 503 when Typesense is unavailable', async () => {
    const { search } = fakeSearch({
      ok: false,
      error: { code: 'search.unavailable', reason: 'timeout' },
    });
    const logger = captureLogger();
    const route = createSearchRoute({ sites, search, limiter: createMemoryRateLimiter(), logger });
    const response = await route(get('/api/search?q=a'), IP);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await errorCode(response)).toBe('search.unavailable');
    expect(logger.lines[0]).toMatchObject({
      level: 'warn',
      event: 'search.request',
      fields: { reason: 'timeout', status: 503 },
    });
  });

  it('returns 503 when the site lookup, the limiter or the client address fails', async () => {
    const broken: SiteResolver = { resolve: () => Promise.reject(new Error('db down')) };
    const failing: RateLimiter = { take: () => Promise.reject(new Error('store down')) };
    const cases = [
      createSearchRoute({
        sites: broken,
        search: fakeSearch().search,
        limiter: createMemoryRateLimiter(),
      })(get('/api/search?q=a'), IP),
      createSearchRoute({ sites, search: fakeSearch().search, limiter: failing })(
        get('/api/search?q=a'),
        IP,
      ),
      createSearchRoute({ sites, search: fakeSearch().search, limiter: createMemoryRateLimiter() })(
        get('/api/search?q=a'),
        'unix:socket',
      ),
    ];
    for (const response of await Promise.all(cases)) expect(response.status).toBe(503);
  });

  it('logs ids, codes and timings for every request', async () => {
    const logger = captureLogger();
    const route = createSearchRoute({
      sites,
      search: fakeSearch().search,
      limiter: createMemoryRateLimiter(),
      logger,
    });
    await route(get('/api/search?q=install'), IP);
    expect(logger.lines).toEqual([
      {
        level: 'info',
        event: 'search.request',
        fields: {
          organizationId: toPublicId('org', TENANT_A.organizationId),
          projectId: toPublicId('prj', TENANT_A.projectId),
          version: 'latest',
          locale: 'default',
          hits: 0,
          typesenseMs: 3,
          status: 200,
          durationMs: expect.any(Number) as number,
        },
      },
    ]);
  });

  it('never writes the query text, the address or the host to a log line, whatever the outcome', async () => {
    const outcomes: SearchResult[] = [
      { ok: true, value: { hits: [], typesenseMs: 1 } },
      { ok: false, error: { code: 'search.unavailable', reason: 'network' } },
    ];
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 4, maxLength: 300 }).filter((q) => q.trim().length >= 4),
        fc.constantFrom(...outcomes),
        fc.constantFrom('', '&version=v1', '&version=BAD', '&locale=de'),
        async (q, outcome, extra) => {
          const logger = captureLogger();
          const route = createSearchRoute({
            sites,
            search: fakeSearch(outcome).search,
            limiter: createMemoryRateLimiter(),
            logger,
          });
          const canary = `Q~${q}`;
          await route(get(`/api/search?q=${encodeURIComponent(canary)}${extra}`), IP);
          const written = JSON.stringify(logger.lines);
          expect(written).not.toContain(canary.trim());
          expect(written).not.toContain(JSON.stringify(canary.trim()).slice(1, -1));
          expect(written).not.toContain(IP);
          expect(written).not.toContain(HOST);
        },
      ),
      { numRuns: 300 },
    );
  });
});

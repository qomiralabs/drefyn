import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { TenantRef } from '@drefyn/tenancy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTypesenseClient } from '../../src/client.ts';
import { createSearchIndexer, ensurePublicSearchKey } from '../../src/indexer.ts';
import { createMemoryRateLimiter } from '../../src/limiter.ts';
import type { LogFields } from '../../src/log.ts';
import { LATEST, DEFAULT_LOCALE } from '../../src/pin.ts';
import { createSearchRoute, type SearchRoute } from '../../src/route.ts';
import { createPublishedSearch } from '../../src/search.ts';
import {
  absence,
  adminClient,
  deleteKey,
  keyIds,
  keyIdsFor,
  newKeyValue,
  newTenant,
  stack,
} from './support/typesense.ts';

const skip = await absence();

const PAGE =
  '<!doctype html><html lang="en"><title>Install</title><main>Install the CLI.</main></html>';

// A stand in for the site host: a static page beside the search route, as a docs site serves
// them. The page never waits on search.
function siteHost(route: SearchRoute): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname !== '/api/search') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
        return;
      }
      const response = await route(
        new Request(url, { method: req.method ?? 'GET' }),
        req.socket.remoteAddress ?? '',
      );
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name] = value;
      });
      res.writeHead(response.status, headers).end(await response.text());
    })();
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server has no port');
  return `http://127.0.0.1:${String(address.port)}`;
}

const close = (server: Server) =>
  new Promise<void>((done) =>
    server.close(() => {
      done();
    }),
  );

describe.skipIf(skip !== null)('the search route over HTTP on compose Typesense', () => {
  const { url, adminKey } = stack();
  const admin = adminClient();
  const searchKey = newKeyValue();
  const tenant: TenantRef = newTenant();
  const lines: { event: string; fields: LogFields }[] = [];
  const logger = {
    info: (event: string, fields: LogFields = {}) => lines.push({ event, fields }),
    warn: (event: string, fields: LogFields = {}) => lines.push({ event, fields }),
    error: (event: string, fields: LogFields = {}) => lines.push({ event, fields }),
  };
  const sites = {
    resolve: (host: string) => Promise.resolve(host === '127.0.0.1' ? tenant : null),
  };
  let up: Server;
  let down: Server;
  let upUrl = '';
  let downUrl = '';
  let createdKeys: number[] = [];

  beforeAll(async () => {
    const before = new Set((await keyIds(admin, adminKey)).map((k) => k.id));
    await ensurePublicSearchKey(admin, adminKey, searchKey);
    createdKeys = await keyIdsFor(admin, adminKey, searchKey, before);
    await createSearchIndexer({ client: admin, adminKey }).indexPages(
      tenant,
      { version: LATEST, locale: DEFAULT_LOCALE },
      [
        {
          nodeId: '0190a3c4-6666-7000-8000-000000000001',
          publishedVersionId: '0190a3c4-6666-7000-8000-000000000002',
          path: '/install',
          title: 'Install',
          headings: ['Requirements'],
          body: 'Install the command line tool with one command.',
        },
      ],
    );
    const live = createPublishedSearch({
      client: createTypesenseClient({ url }),
      searchKey,
      logger,
    });
    up = siteHost(
      createSearchRoute({ sites, search: live, limiter: createMemoryRateLimiter(), logger }),
    );
    // Port 1 refuses connections, which is what a stopped Typesense looks like to the proxy.
    const dead = createPublishedSearch({
      client: createTypesenseClient({ url: 'http://127.0.0.1:1', timeoutMs: 500 }),
      searchKey,
      logger,
    });
    down = siteHost(
      createSearchRoute({ sites, search: dead, limiter: createMemoryRateLimiter(), logger }),
    );
    upUrl = await listen(up);
    downUrl = await listen(down);
  });

  afterAll(async () => {
    await close(up);
    await close(down);
    await createSearchIndexer({ client: admin, adminKey }).dropSite(tenant);
    for (const id of createdKeys) await deleteKey(admin, adminKey, id);
  });

  it('answers a search with the site page', async () => {
    const response = await fetch(`${upUrl}/api/search?q=install`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { hits: { path: string }[] };
    expect(body.hits.map((hit) => hit.path)).toEqual(['/install']);
  });

  it('returns 429 with Retry-After once a client passes 30 searches a minute', async () => {
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    // The first test used one of the 30.
    for (let i = 0; i < 30; i += 1) {
      const response = await fetch(`${upUrl}/api/search?q=install`);
      statuses.push(response.status);
      if (response.status === 429) retryAfter = response.headers.get('retry-after');
      await response.body?.cancel();
    }
    expect(statuses.slice(0, 29).every((s) => s === 200)).toBe(true);
    expect(statuses[29]).toBe(429);
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
    expect(Number(retryAfter)).toBeLessThanOrEqual(60);
  });

  it('returns 503 when Typesense is down, and the page beside it still renders', async () => {
    const search = await fetch(`${downUrl}/api/search?q=install`);
    expect(search.status).toBe(503);
    expect(((await search.json()) as { error: { code: string } }).error.code).toBe(
      'search.unavailable',
    );
    const page = await fetch(`${downUrl}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Install the CLI.');
  });

  it('logged ids and outcomes for every request, never the query text', () => {
    const requests = lines.filter((line) => line.event === 'search.request');
    expect(requests.length).toBeGreaterThanOrEqual(32);
    for (const line of requests) {
      expect(line.fields['organizationId']).toMatch(/^org_/);
      expect(line.fields['projectId']).toMatch(/^prj_/);
    }
    expect(JSON.stringify(lines)).not.toContain('install');
  });
});

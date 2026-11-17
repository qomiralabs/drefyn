import { toPublicId, idOf } from '@drefyn/tenancy';
import { describe, expect, it } from 'vitest';
import { SearchUnavailableError } from '../src/client.ts';
import {
  MARK_END,
  MARK_START,
  publicCollectionFor,
  publishedFilter,
  type QueryBuilder,
} from '../src/filter.ts';
import { parseSearchQuery, type SearchQuery } from '../src/query.ts';
import { createPublishedSearch, excerptOf } from '../src/search.ts';
import {
  captureLogger,
  decodeScopedKey,
  json,
  NODE_1,
  scriptedClient,
  TENANT_A,
  TENANT_B,
  pinOf,
} from './support.ts';

const SEARCH_KEY = 'publicparentkey0123456789abcdefghij';
const NOW = 1_800_000_000_000;
const PIN = pinOf('v2', 'en');
const query = (text: string) => (parseSearchQuery(text) as { query: SearchQuery }).query;

const doc = (tenant = TENANT_A, extra: Record<string, unknown> = {}) => ({
  document: {
    organization_id: tenant.organizationId,
    project_id: tenant.projectId,
    node_id: NODE_1,
    path: '/guides/install',
    title: 'Install',
    ...extra,
  },
  highlight: { body: { snippet: `Run ${MARK_START}install${MARK_END} first` } },
});

describe('createPublishedSearch', () => {
  it('hands Typesense a short lived scoped key that embeds the tenant filter and closes pinned hits', async () => {
    const client = scriptedClient(json(200, { hits: [] }));
    const search = createPublishedSearch({ client, searchKey: SEARCH_KEY, now: () => NOW });
    await search.searchPublished(TENANT_A, PIN, query('install'));
    const [call] = client.calls;
    expect(call?.method).toBe('GET');
    expect(call?.idempotent).toBe(true);
    expect(call?.path).toBe(`/collections/${publicCollectionFor(TENANT_A)}/documents/search`);
    expect(call?.key).not.toBe(SEARCH_KEY);
    const decoded = decodeScopedKey(call?.key ?? '');
    expect(decoded.prefix).toBe(SEARCH_KEY.slice(0, 4));
    expect(decoded.params).toEqual({
      filter_by: publishedFilter(TENANT_A, PIN),
      expires_at: NOW / 1000 + 60,
      filter_curated_hits: true,
      enable_overrides: false,
      limit_hits: 20,
    });
    expect(call?.query?.['q']).toBe('install');
  });

  it('builds the key from the tenant even when the query builder forgets it', async () => {
    const forgetful: QueryBuilder = (_tenant, _pin, q) => ({
      collection: publicCollectionFor(TENANT_B),
      params: { q, query_by: 'title' },
    });
    const client = scriptedClient(json(200, { hits: [] }));
    const search = createPublishedSearch({ client, searchKey: SEARCH_KEY, buildQuery: forgetful });
    await search.searchPublished(TENANT_A, PIN, query('install'));
    const decoded = decodeScopedKey(client.calls[0]?.key ?? '') as {
      params: { filter_by: string };
    };
    expect(decoded.params.filter_by).toBe(publishedFilter(TENANT_A, PIN));
  });

  it('returns hits with public node ids and a plain text excerpt', async () => {
    const client = scriptedClient(json(200, { found: 1, hits: [doc()] }));
    const search = createPublishedSearch({ client, searchKey: SEARCH_KEY });
    const result = await search.searchPublished(TENANT_A, PIN, query('install'));
    expect(result).toMatchObject({
      ok: true,
      value: {
        hits: [
          {
            nodeId: toPublicId('nod', idOf('nod', NODE_1)),
            path: '/guides/install',
            title: 'Install',
            excerpt: [
              { text: 'Run ', match: false },
              { text: 'install', match: true },
              { text: ' first', match: false },
            ],
          },
        ],
      },
    });
  });

  it('drops a foreign hit and says so, should the key and the filter both fail', async () => {
    const logger = captureLogger();
    const client = scriptedClient(json(200, { hits: [doc(TENANT_B), doc()] }));
    const search = createPublishedSearch({ client, searchKey: SEARCH_KEY, logger });
    const result = await search.searchPublished(TENANT_A, PIN, query('install'));
    expect(result.ok && result.value.hits).toHaveLength(1);
    const line = logger.lines.find((l) => l.event === 'search.foreign_hit');
    expect(line?.level).toBe('error');
    expect(line?.fields['count']).toBe(1);
  });

  it('skips a hit whose node id is not a UUID, and one without a highlight has no excerpt', async () => {
    const plain = { document: doc().document };
    const client = scriptedClient(json(200, { hits: [doc(TENANT_A, { node_id: 'nope' }), plain] }));
    const search = createPublishedSearch({ client, searchKey: SEARCH_KEY });
    const result = await search.searchPublished(TENANT_A, PIN, query('install'));
    expect(result.ok && result.value.hits.map((hit) => hit.excerpt)).toEqual([[]]);
  });

  it('never returns more than 20 hits', async () => {
    const client = scriptedClient(json(200, { hits: Array.from({ length: 25 }, () => doc()) }));
    const search = createPublishedSearch({ client, searchKey: SEARCH_KEY });
    const result = await search.searchPublished(TENANT_A, PIN, query('install'));
    expect(result.ok && result.value.hits).toHaveLength(20);
  });

  it('reads a site with no collection yet as no hits', async () => {
    const client = scriptedClient(json(404, { message: 'Not Found' }));
    const search = createPublishedSearch({ client, searchKey: SEARCH_KEY });
    const result = await search.searchPublished(TENANT_A, PIN, query('install'));
    expect(result).toMatchObject({ ok: true, value: { hits: [] } });
  });

  it.each([
    ['an outage', new SearchUnavailableError('timeout'), 'timeout', 'search.typesense_unavailable'],
    ['a refused key', json(401, { message: 'Forbidden' }), 'rejected', 'search.typesense_rejected'],
    [
      'a body that is not JSON',
      { status: 200, text: '<html>' },
      'bad_response',
      'search.typesense_bad_response',
    ],
    [
      'a body of the wrong shape',
      json(200, { hits: [{ document: {} }] }),
      'bad_response',
      'search.typesense_bad_response',
    ],
  ])('reports %s as unavailable with a reason', async (_label, answer, reason, event) => {
    const logger = captureLogger();
    const client = scriptedClient(answer);
    const search = createPublishedSearch({ client, searchKey: SEARCH_KEY, logger });
    const result = await search.searchPublished(TENANT_A, PIN, query('install'));
    expect(result).toEqual({ ok: false, error: { code: 'search.unavailable', reason } });
    expect(logger.lines.map((line) => line.event)).toEqual([event]);
    expect(logger.lines[0]?.fields).toMatchObject({
      organizationId: toPublicId('org', TENANT_A.organizationId),
      projectId: toPublicId('prj', TENANT_A.projectId),
    });
  });

  it('lets an unexpected error through rather than calling it an outage', async () => {
    const client = scriptedClient(new Error('bug'));
    const search = createPublishedSearch({ client, searchKey: SEARCH_KEY });
    await expect(search.searchPublished(TENANT_A, PIN, query('install'))).rejects.toThrow('bug');
  });

  it('refuses a key lifetime out of range and a key too short to be real', () => {
    const client = scriptedClient();
    expect(() =>
      createPublishedSearch({ client, searchKey: SEARCH_KEY, keyTtlSeconds: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      createPublishedSearch({ client, searchKey: SEARCH_KEY, keyTtlSeconds: 3601 }),
    ).toThrow(RangeError);
    expect(() => createPublishedSearch({ client, searchKey: 'short' })).toThrow(RangeError);
  });
});

describe('excerptOf', () => {
  it('splits marked snippets into parts', () => {
    expect(excerptOf(undefined)).toEqual([]);
    expect(excerptOf('')).toEqual([]);
    expect(excerptOf('plain')).toEqual([{ text: 'plain', match: false }]);
    expect(excerptOf(`${MARK_START}a${MARK_END}${MARK_START}b${MARK_END}`)).toEqual([
      { text: 'a', match: true },
      { text: 'b', match: true },
    ]);
  });

  it('copes with markers that do not pair up', () => {
    expect(excerptOf(`x${MARK_START}open`)).toEqual([
      { text: 'x', match: false },
      { text: 'open', match: true },
    ]);
    expect(excerptOf(`stray${MARK_END} end`)).toEqual([{ text: 'stray end', match: false }]);
    expect(excerptOf(`${MARK_START}${MARK_END}`)).toEqual([]);
  });
});

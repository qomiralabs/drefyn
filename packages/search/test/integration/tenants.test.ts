import type { TenantRef } from '@drefyn/tenancy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TypesenseAnswer, TypesenseCall, TypesenseClient } from '../../src/client.ts';
import { publicCollectionFor, type QueryBuilder } from '../../src/filter.ts';
import {
  createSearchIndexer,
  ensurePublicSearchKey,
  type PublishedPage,
} from '../../src/indexer.ts';
import { pinOf } from '../support.ts';
import { parseSearchQuery, type SearchQuery } from '../../src/query.ts';
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
if (skip !== null) console.warn(`search integration skipped: ${skip}`);

const pin = pinOf;
const query = (text: string) => (parseSearchQuery(text) as { query: SearchQuery }).query;
const LATEST = pin('latest', 'default');
const V1 = pin('v1', 'default');
const FR = pin('latest', 'fr');

const uuid = (n: number) => `0190a3c4-5555-7000-8000-${n.toString(16).padStart(12, '0')}`;
const page = (n: number, body: string): PublishedPage => ({
  nodeId: uuid(n),
  publishedVersionId: uuid(1000 + n),
  path: `/page-${String(n)}`,
  title: `Page ${String(n)}`,
  headings: [],
  body,
});

// Records every raw answer, so a test can show what Typesense itself returned before the
// package's own last check ran.
function recording(inner: TypesenseClient) {
  const answers: { call: TypesenseCall; answer: TypesenseAnswer }[] = [];
  const client: TypesenseClient = {
    async call(call) {
      const answer = await inner.call(call);
      answers.push({ call, answer });
      return answer;
    },
  };
  return { client, answers };
}

const rawIds = (answer: TypesenseAnswer | undefined): string[] => {
  const body = JSON.parse(answer?.text ?? '{}') as { hits?: { document: { node_id: string } }[] };
  return (body.hits ?? []).map((hit) => hit.document.node_id).sort();
};

describe.skipIf(skip !== null)('public search on compose Typesense with two tenants', () => {
  const { adminKey } = stack();
  const admin = adminClient();
  const searchKey = newKeyValue();
  const a: TenantRef = newTenant();
  const b: TenantRef = newTenant();
  let createdKeys: number[] = [];

  beforeAll(async () => {
    const before = new Set((await keyIds(admin, adminKey)).map((k) => k.id));
    await ensurePublicSearchKey(admin, adminKey, searchKey);
    // A second run with the same value is the restart case and must not fail.
    await ensurePublicSearchKey(admin, adminKey, searchKey);
    createdKeys = await keyIdsFor(admin, adminKey, searchKey, before);
    expect(createdKeys).toHaveLength(1);

    const indexer = createSearchIndexer({ client: admin, adminKey });
    await indexer.indexPages(a, LATEST, [
      page(1, 'canary alpha latest'),
      page(2, 'canary alpha second'),
    ]);
    await indexer.indexPages(a, V1, [page(1, 'canary alpha old line')]);
    await indexer.indexPages(a, FR, [page(1, 'canary alpha en francais')]);
    await indexer.indexPages(b, LATEST, [
      page(3, 'canary bravo secret'),
      page(4, 'canary bravo other'),
    ]);
  });

  afterAll(async () => {
    const indexer = createSearchIndexer({ client: admin, adminKey });
    await indexer.dropSite(a);
    await indexer.dropSite(b);
    for (const id of createdKeys) await deleteKey(admin, adminKey, id);
  });

  it('returns only the requesting site, version and language', async () => {
    const search = createPublishedSearch({ client: admin, searchKey });
    const fromA = await search.searchPublished(a, LATEST, query('canary'));
    expect(fromA.ok && fromA.value.hits.map((h) => h.path).sort()).toEqual(['/page-1', '/page-2']);
    const fromB = await search.searchPublished(b, LATEST, query('canary'));
    expect(fromB.ok && fromB.value.hits.map((h) => h.path).sort()).toEqual(['/page-3', '/page-4']);
    const old = await search.searchPublished(a, V1, query('canary'));
    expect(old.ok && old.value.hits.map((h) => h.path)).toEqual(['/page-1']);
    const french = await search.searchPublished(a, FR, query('francais'));
    expect(french.ok && french.value.hits).toHaveLength(1);
    const elsewhere = await search.searchPublished(a, LATEST, query('bravo'));
    expect(elsewhere).toMatchObject({ ok: true, value: { hits: [] } });
  });

  it('marks the matched words in a plain text excerpt', async () => {
    const search = createPublishedSearch({ client: admin, searchKey });
    const result = await search.searchPublished(a, LATEST, query('second'));
    expect(result.ok && result.value.hits[0]?.excerpt).toContainEqual({
      text: 'second',
      match: true,
    });
  });

  it('a builder that drops the tenant filter and reads another site still gets no foreign hit', async () => {
    const { client, answers } = recording(admin);
    const faulty: QueryBuilder = (_tenant, _pin, q) => ({
      collection: publicCollectionFor(b),
      params: { q, query_by: 'title,headings,body', per_page: '20' },
    });
    const search = createPublishedSearch({ client, searchKey, buildQuery: faulty });
    const result = await search.searchPublished(a, LATEST, query('canary'));
    expect(answers[0]?.answer.status).toBe(200);
    // Typesense itself returned nothing, so the package's own last check had nothing to drop.
    expect(rawIds(answers[0]?.answer)).toEqual([]);
    expect(result).toMatchObject({ ok: true, value: { hits: [] } });
  });

  it('a builder that drops the filter on its own site still gets only the pinned version and language', async () => {
    const { client, answers } = recording(admin);
    const faulty: QueryBuilder = (tenant, _pin, q) => ({
      collection: publicCollectionFor(tenant),
      params: { q, query_by: 'title,headings,body', per_page: '20' },
    });
    const search = createPublishedSearch({ client, searchKey, buildQuery: faulty });
    await search.searchPublished(a, LATEST, query('canary'));
    expect(rawIds(answers[0]?.answer)).toEqual([uuid(1), uuid(2)]);
  });

  it('a builder that forwards widening parameters is held by the key', async () => {
    const { client, answers } = recording(admin);
    const faulty: QueryBuilder = (_tenant, _pin, q) => ({
      collection: publicCollectionFor(b),
      params: {
        q,
        query_by: 'title,headings,body',
        filter_by: `organization_id:=${b.organizationId} || visibility:=public`,
        pinned_hits: `${uuid(3)}.latest.default:1`,
        filter_curated_hits: 'false',
        enable_overrides: 'true',
      },
    });
    const search = createPublishedSearch({ client, searchKey, buildQuery: faulty });
    await search.searchPublished(a, LATEST, query('canary'));
    expect(answers[0]?.answer.status).toBe(200);
    expect(rawIds(answers[0]?.answer)).toEqual([]);
  });

  it('the parent key reaches no collection outside the public pattern', async () => {
    const name = `docs_prot_${a.projectId.replaceAll('-', '')}`;
    await admin.call({
      method: 'POST',
      path: '/collections',
      key: adminKey,
      body: JSON.stringify({ name, fields: [{ name: 'body', type: 'string' }] }),
      idempotent: false,
    });
    try {
      const answer = await admin.call({
        method: 'GET',
        path: `/collections/${name}/documents/search`,
        key: searchKey,
        query: { q: '*', query_by: 'body' },
        idempotent: true,
      });
      expect(answer.status).toBe(401);
    } finally {
      await admin.call({
        method: 'DELETE',
        path: `/collections/${name}`,
        key: adminKey,
        idempotent: true,
      });
    }
  });

  it('removes a page from one pin only', async () => {
    const indexer = createSearchIndexer({ client: admin, adminKey });
    const search = createPublishedSearch({ client: admin, searchKey });
    await indexer.removePages(a, V1, [uuid(1)]);
    expect(await search.searchPublished(a, V1, query('canary'))).toMatchObject({
      ok: true,
      value: { hits: [] },
    });
    const latest = await search.searchPublished(a, LATEST, query('canary'));
    expect(latest.ok && latest.value.hits).toHaveLength(2);
  });

  it('reads a site with nothing indexed as no hits', async () => {
    const search = createPublishedSearch({ client: admin, searchKey });
    expect(await search.searchPublished(newTenant(), LATEST, query('canary'))).toMatchObject({
      ok: true,
      value: { hits: [] },
    });
  });
});

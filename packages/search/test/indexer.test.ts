import { describe, expect, it } from 'vitest';
import {
  MARK_END,
  MARK_START,
  PUBLIC_COLLECTION_PATTERN,
  publicCollectionFor,
} from '../src/filter.ts';
import {
  createSearchIndexer,
  ensurePublicSearchKey,
  MAX_PAGES_PER_CALL,
  SearchIndexError,
  type PublishedPage,
} from '../src/indexer.ts';
import {
  captureLogger,
  json,
  NODE_1,
  pinOf,
  scriptedClient,
  TENANT_A,
  VERSION_1,
} from './support.ts';

const ADMIN = 'adminkey0123456789abcdefghijklmnopq';
const PIN = pinOf('v1', 'fr');
const COLLECTION = publicCollectionFor(TENANT_A);

const page = (extra: Partial<PublishedPage> = {}): PublishedPage => ({
  nodeId: NODE_1,
  publishedVersionId: VERSION_1,
  path: '/guides/install',
  title: 'Install',
  headings: ['Before you start'],
  body: 'Run the installer.',
  ...extra,
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SearchIndexError) return error.code;
    throw error;
  }
  return 'resolved';
}

describe('ensureSite', () => {
  it('does nothing when the collection exists', async () => {
    const client = scriptedClient(json(200, { name: COLLECTION }));
    await createSearchIndexer({ client, adminKey: ADMIN }).ensureSite(TENANT_A);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      method: 'GET',
      path: `/collections/${COLLECTION}`,
      key: ADMIN,
    });
  });

  it('creates a missing collection with the tenant fields, and a lost race is fine', async () => {
    for (const status of [201, 409]) {
      const logger = captureLogger();
      const client = scriptedClient(json(404, {}), json(status, {}));
      await createSearchIndexer({ client, adminKey: ADMIN, logger }).ensureSite(TENANT_A);
      const body = JSON.parse(client.calls[1]?.body ?? '{}') as {
        name: string;
        fields: { name: string }[];
      };
      expect(body.name).toBe(COLLECTION);
      expect(body.fields.map((f) => f.name)).toEqual(
        expect.arrayContaining([
          'organization_id',
          'project_id',
          'version_key',
          'locale',
          'visibility',
        ]),
      );
      expect(logger.lines.map((l) => l.event)).toEqual(['search.site_created']);
    }
  });

  it('reports any other answer as rejected', async () => {
    expect(
      await codeOf(
        createSearchIndexer({ client: scriptedClient(json(401, {})), adminKey: ADMIN }).ensureSite(
          TENANT_A,
        ),
      ),
    ).toBe('search.index_rejected');
    expect(
      await codeOf(
        createSearchIndexer({
          client: scriptedClient(json(404, {}), json(400, {})),
          adminKey: ADMIN,
        }).ensureSite(TENANT_A),
      ),
    ).toBe('search.index_rejected');
  });
});

describe('indexPages', () => {
  it('upserts one document per page with tenant fields from the TenantRef and the pin', async () => {
    const logger = captureLogger();
    const client = scriptedClient(json(200, {}), {
      status: 200,
      text: '{"success":true}\n{"success":true}',
    });
    const hostile = {
      ...page(),
      organization_id: 'other',
      visibility: 'protected',
    } as PublishedPage;
    await createSearchIndexer({ client, adminKey: ADMIN, logger }).indexPages(TENANT_A, PIN, [
      hostile,
      page({ nodeId: '0190a3c4-3333-7000-8000-000000000002', title: `A${MARK_START}B${MARK_END}` }),
    ]);
    const call = client.calls[1];
    expect(call).toMatchObject({
      method: 'POST',
      path: `/collections/${COLLECTION}/documents/import`,
      query: { action: 'upsert' },
      contentType: 'text/plain',
      idempotent: true,
    });
    const docs = (call?.body ?? '')
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(docs[0]).toEqual({
      id: `${NODE_1}.v1.fr`,
      organization_id: TENANT_A.organizationId,
      project_id: TENANT_A.projectId,
      version_key: 'v1',
      locale: 'fr',
      visibility: 'public',
      node_id: NODE_1,
      published_version_id: VERSION_1,
      path: '/guides/install',
      title: 'Install',
      headings: ['Before you start'],
      body: 'Run the installer.',
    });
    expect(docs[1]?.['title']).toBe('AB');
    expect(logger.lines.map((l) => l.event)).toEqual(['search.indexed']);
  });

  it('caps long text', async () => {
    const client = scriptedClient(json(200, {}), { status: 200, text: '{"success":true}' });
    await createSearchIndexer({ client, adminKey: ADMIN }).indexPages(TENANT_A, PIN, [
      page({
        body: 'x'.repeat(200_000),
        headings: Array.from({ length: 300 }, () => 'h'.repeat(300)),
      }),
    ]);
    const doc = JSON.parse(client.calls[1]?.body ?? '{}') as { body: string; headings: string[] };
    expect(doc.body).toHaveLength(100_000);
    expect(doc.headings).toHaveLength(200);
    expect(doc.headings[0]).toHaveLength(200);
  });

  it('does nothing for no pages', async () => {
    const client = scriptedClient();
    await createSearchIndexer({ client, adminKey: ADMIN }).indexPages(TENANT_A, PIN, []);
    expect(client.calls).toHaveLength(0);
  });

  it('refuses a batch that is too big or a page that is not valid, before any call', async () => {
    const client = scriptedClient();
    const indexer = createSearchIndexer({ client, adminKey: ADMIN });
    const many = Array.from({ length: MAX_PAGES_PER_CALL + 1 }, () => page());
    expect(await codeOf(indexer.indexPages(TENANT_A, PIN, many))).toBe('search.too_many_pages');
    expect(await codeOf(indexer.indexPages(TENANT_A, PIN, [page({ nodeId: 'x' })]))).toBe(
      'search.page_invalid',
    );
    expect(await codeOf(indexer.indexPages(TENANT_A, PIN, [page({ path: 'relative' })]))).toBe(
      'search.page_invalid',
    );
    expect(client.calls).toHaveLength(0);
  });

  it('reports a refused import and any failed line', async () => {
    const refused = scriptedClient(json(200, {}), json(400, {}));
    expect(
      await codeOf(
        createSearchIndexer({ client: refused, adminKey: ADMIN }).indexPages(TENANT_A, PIN, [
          page(),
        ]),
      ),
    ).toBe('search.index_rejected');
    for (const text of ['{"success":false,"error":"bad"}', 'not json', '{"other":1}']) {
      const logger = captureLogger();
      const client = scriptedClient(json(200, {}), {
        status: 200,
        text: `{"success":true}\n${text}\n`,
      });
      expect(
        await codeOf(
          createSearchIndexer({ client, adminKey: ADMIN, logger }).indexPages(TENANT_A, PIN, [
            page(),
            page(),
          ]),
        ),
      ).toBe('search.index_rejected');
      expect(logger.lines[0]).toMatchObject({
        event: 'search.index_failed',
        fields: { failed: 1, pages: 2 },
      });
    }
  });
});

describe('removePages and dropSite', () => {
  it('deletes the pinned documents by id', async () => {
    const client = scriptedClient(json(200, { num_deleted: 1 }));
    await createSearchIndexer({ client, adminKey: ADMIN }).removePages(TENANT_A, PIN, [NODE_1]);
    expect(client.calls[0]).toMatchObject({
      method: 'DELETE',
      path: `/collections/${COLLECTION}/documents`,
      query: { filter_by: `id:=[\`${NODE_1}.v1.fr\`]` },
      idempotent: true,
    });
  });

  it('treats a missing collection as already removed and refuses bad input', async () => {
    const indexer = createSearchIndexer({ client: scriptedClient(json(404, {})), adminKey: ADMIN });
    await indexer.removePages(TENANT_A, PIN, [NODE_1]);
    await indexer.removePages(TENANT_A, PIN, []);
    expect(await codeOf(indexer.removePages(TENANT_A, PIN, ['nope']))).toBe('search.page_invalid');
    const many = Array.from({ length: MAX_PAGES_PER_CALL + 1 }, () => NODE_1);
    expect(await codeOf(indexer.removePages(TENANT_A, PIN, many))).toBe('search.too_many_pages');
    const refused = createSearchIndexer({ client: scriptedClient(json(401, {})), adminKey: ADMIN });
    expect(await codeOf(refused.removePages(TENANT_A, PIN, [NODE_1]))).toBe(
      'search.index_rejected',
    );
  });

  it('drops the whole site collection', async () => {
    for (const status of [200, 404]) {
      const client = scriptedClient(json(status, {}));
      await createSearchIndexer({ client, adminKey: ADMIN }).dropSite(TENANT_A);
      expect(client.calls[0]).toMatchObject({
        method: 'DELETE',
        path: `/collections/${COLLECTION}`,
      });
    }
    const refused = createSearchIndexer({ client: scriptedClient(json(500, {})), adminKey: ADMIN });
    expect(await codeOf(refused.dropSite(TENANT_A))).toBe('search.index_rejected');
  });
});

describe('ensurePublicSearchKey', () => {
  const VALUE = 'publicparentkey0123456789abcdefghij';

  it('creates a search only key limited to public site collections, and an existing one is fine', async () => {
    for (const status of [201, 409]) {
      const client = scriptedClient(json(status, {}));
      await ensurePublicSearchKey(client, ADMIN, VALUE);
      expect(client.calls[0]).toMatchObject({ method: 'POST', path: '/keys', key: ADMIN });
      expect(JSON.parse(client.calls[0]?.body ?? '{}')).toEqual({
        description: 'drefyn public search parent',
        actions: ['documents:search'],
        collections: [PUBLIC_COLLECTION_PATTERN],
        value: VALUE,
      });
    }
  });

  it('refuses a short value, the admin key itself and a refused create', async () => {
    await expect(ensurePublicSearchKey(scriptedClient(), ADMIN, 'short')).rejects.toThrow(
      RangeError,
    );
    await expect(ensurePublicSearchKey(scriptedClient(), ADMIN, ADMIN)).rejects.toThrow(RangeError);
    expect(await codeOf(ensurePublicSearchKey(scriptedClient(json(401, {})), ADMIN, VALUE))).toBe(
      'search.index_rejected',
    );
  });
});

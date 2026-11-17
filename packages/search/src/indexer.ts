import { toPublicId, type TenantRef } from '@drefyn/tenancy';
import { z } from 'zod';
import type { TypesenseClient } from './client.ts';
import { MARK_END, MARK_START, PUBLIC_COLLECTION_PATTERN, publicCollectionFor } from './filter.ts';
import { noopLogger, type SearchLogger } from './log.ts';
import type { SearchPin } from './pin.ts';

// One published page in one version line and language, as the host read it through the public
// reader. Text only: the host flattens the page, and nothing here parses MDX.
export interface PublishedPage {
  readonly nodeId: string;
  readonly publishedVersionId: string;
  readonly path: string;
  readonly title: string;
  readonly headings: readonly string[];
  readonly body: string;
}

export const MAX_PAGES_PER_CALL = 500;
const MAX_BODY_CHARS = 100_000;
const MAX_TITLE_CHARS = 512;
const MAX_HEADINGS = 200;
const MAX_HEADING_CHARS = 200;
const IMPORT_TIMEOUT_MS = 30_000;

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

const pageSchema = z.object({
  nodeId: uuid,
  publishedVersionId: uuid,
  path: z.string().startsWith('/').max(2048),
  title: z.string(),
  headings: z.array(z.string()),
  body: z.string(),
});

// The markers are how a snippet shows a match, so page text must never hold them.
const stripMarks = (text: string, max: number): string =>
  text.replaceAll(MARK_START, '').replaceAll(MARK_END, '').slice(0, max);

const FIELDS = [
  { name: 'organization_id', type: 'string' },
  { name: 'project_id', type: 'string' },
  { name: 'version_key', type: 'string' },
  { name: 'locale', type: 'string' },
  { name: 'visibility', type: 'string' },
  { name: 'node_id', type: 'string' },
  { name: 'title', type: 'string' },
  { name: 'headings', type: 'string[]' },
  { name: 'body', type: 'string' },
] as const;

export interface SearchIndexer {
  ensureSite(tenant: TenantRef): Promise<void>;
  indexPages(tenant: TenantRef, pin: SearchPin, pages: readonly PublishedPage[]): Promise<void>;
  removePages(tenant: TenantRef, pin: SearchPin, nodeIds: readonly string[]): Promise<void>;
  dropSite(tenant: TenantRef): Promise<void>;
}

export class SearchIndexError extends Error {
  readonly code: 'search.index_rejected' | 'search.page_invalid' | 'search.too_many_pages';
  readonly status: number | undefined;
  constructor(code: SearchIndexError['code'], status?: number) {
    super(code);
    this.name = 'SearchIndexError';
    this.code = code;
    this.status = status;
  }
}

export interface SearchIndexerDeps {
  readonly client: TypesenseClient;
  // Typesense's admin key. Only the indexer holds it; the public path never does.
  readonly adminKey: string;
  readonly logger?: SearchLogger;
}

const documentId = (pin: SearchPin, nodeId: string) => `${nodeId}.${pin.version}.${pin.locale}`;

const importLineSchema = z.object({ success: z.boolean() });

// Writes only through the admin key and only into the tenant's own collection. Every tenant
// field on a document comes from the TenantRef and the pin, never from the page.
export function createSearchIndexer(deps: SearchIndexerDeps): SearchIndexer {
  const logger = deps.logger ?? noopLogger;
  const { client, adminKey } = deps;
  const ids = (tenant: TenantRef) => ({
    organizationId: toPublicId('org', tenant.organizationId),
    projectId: toPublicId('prj', tenant.projectId),
  });

  async function ensureSite(tenant: TenantRef): Promise<void> {
    const collection = publicCollectionFor(tenant);
    const found = await client.call({
      method: 'GET',
      path: `/collections/${collection}`,
      key: adminKey,
      idempotent: true,
    });
    if (found.status === 200) return;
    if (found.status !== 404) throw new SearchIndexError('search.index_rejected', found.status);
    const made = await client.call({
      method: 'POST',
      path: '/collections',
      key: adminKey,
      body: JSON.stringify({ name: collection, fields: FIELDS }),
      // A second create of the same name is refused with 409, so a retry is safe.
      idempotent: true,
    });
    if (made.status !== 201 && made.status !== 409) {
      throw new SearchIndexError('search.index_rejected', made.status);
    }
    logger.info('search.site_created', ids(tenant));
  }

  return Object.freeze({
    ensureSite,

    async indexPages(tenant: TenantRef, pin: SearchPin, pages: readonly PublishedPage[]) {
      if (pages.length === 0) return;
      if (pages.length > MAX_PAGES_PER_CALL) throw new SearchIndexError('search.too_many_pages');
      const lines: string[] = [];
      for (const raw of pages) {
        const parsed = pageSchema.safeParse(raw);
        if (!parsed.success) throw new SearchIndexError('search.page_invalid');
        const page = parsed.data;
        lines.push(
          JSON.stringify({
            id: documentId(pin, page.nodeId),
            organization_id: tenant.organizationId,
            project_id: tenant.projectId,
            version_key: pin.version,
            locale: pin.locale,
            visibility: 'public',
            node_id: page.nodeId,
            published_version_id: page.publishedVersionId,
            path: page.path,
            title: stripMarks(page.title, MAX_TITLE_CHARS),
            headings: page.headings
              .slice(0, MAX_HEADINGS)
              .map((heading) => stripMarks(heading, MAX_HEADING_CHARS)),
            body: stripMarks(page.body, MAX_BODY_CHARS),
          }),
        );
      }
      await ensureSite(tenant);
      const answer = await client.call({
        method: 'POST',
        path: `/collections/${publicCollectionFor(tenant)}/documents/import`,
        key: adminKey,
        query: { action: 'upsert' },
        body: lines.join('\n'),
        contentType: 'text/plain',
        // Upserts by id, so sending the batch twice leaves the same documents.
        idempotent: true,
        timeoutMs: IMPORT_TIMEOUT_MS,
      });
      if (answer.status !== 200) throw new SearchIndexError('search.index_rejected', answer.status);
      const failed = answer.text
        .split('\n')
        .filter((line) => line.trim() !== '')
        .filter((line) => {
          try {
            const parsed = importLineSchema.safeParse(JSON.parse(line));
            return !parsed.success || !parsed.data.success;
          } catch {
            return true;
          }
        }).length;
      if (failed > 0) {
        logger.error('search.index_failed', { ...ids(tenant), failed, pages: pages.length });
        throw new SearchIndexError('search.index_rejected', answer.status);
      }
      logger.info('search.indexed', { ...ids(tenant), pages: pages.length });
    },

    async removePages(tenant: TenantRef, pin: SearchPin, nodeIds: readonly string[]) {
      if (nodeIds.length === 0) return;
      if (nodeIds.length > MAX_PAGES_PER_CALL) throw new SearchIndexError('search.too_many_pages');
      for (const id of nodeIds) {
        if (!uuid.safeParse(id).success) throw new SearchIndexError('search.page_invalid');
      }
      const answer = await client.call({
        method: 'DELETE',
        path: `/collections/${publicCollectionFor(tenant)}/documents`,
        key: adminKey,
        query: {
          filter_by: `id:=[${nodeIds.map((id) => `\`${documentId(pin, id)}\``).join(',')}]`,
        },
        idempotent: true,
      });
      if (answer.status !== 200 && answer.status !== 404) {
        throw new SearchIndexError('search.index_rejected', answer.status);
      }
      logger.info('search.removed', { ...ids(tenant), pages: nodeIds.length });
    },

    async dropSite(tenant: TenantRef) {
      const answer = await client.call({
        method: 'DELETE',
        path: `/collections/${publicCollectionFor(tenant)}`,
        key: adminKey,
        idempotent: true,
      });
      if (answer.status !== 200 && answer.status !== 404) {
        throw new SearchIndexError('search.index_rejected', answer.status);
      }
      logger.info('search.site_dropped', ids(tenant));
    },
  });
}

// The parent of every public scoped key: search only, and only on public site collections.
// Typesense refuses a second key with the same value with 409, so running this at every start
// is safe. Typesense only lists a key's first four characters, so a changed value is a new key;
// the old one stays until an operator deletes it.
export async function ensurePublicSearchKey(
  client: TypesenseClient,
  adminKey: string,
  value: string,
): Promise<void> {
  if (value.length < 32)
    throw new RangeError('the public search key must be at least 32 characters');
  if (value === adminKey)
    throw new RangeError('the public search key must differ from the admin key');
  const answer = await client.call({
    method: 'POST',
    path: '/keys',
    key: adminKey,
    body: JSON.stringify({
      description: 'drefyn public search parent',
      actions: ['documents:search'],
      collections: [PUBLIC_COLLECTION_PATTERN],
      value,
    }),
    idempotent: true,
  });
  if (answer.status !== 201 && answer.status !== 409) {
    throw new SearchIndexError('search.index_rejected', answer.status);
  }
}

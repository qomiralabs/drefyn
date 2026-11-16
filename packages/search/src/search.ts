import { idOf, toPublicId, type TenantRef } from '@drefyn/tenancy';
import { z } from 'zod';
import { SearchUnavailableError, type TypesenseClient, type UnavailableReason } from './client.ts';
import {
  buildPublishedQuery,
  MARK_END,
  MARK_START,
  MAX_HITS,
  publishedFilter,
  type QueryBuilder,
} from './filter.ts';
import { noopLogger, type SearchLogger } from './log.ts';
import type { SearchPin } from './pin.ts';
import type { SearchQuery } from './query.ts';
import { generateScopedKey, type ScopedKeyParams } from './scoped-key.ts';

export interface ExcerptPart {
  readonly text: string;
  readonly match: boolean;
}

export interface SearchHit {
  readonly nodeId: string;
  readonly path: string;
  readonly title: string;
  // Plain text in order; match marks the words that matched. Rendered as text, never as HTML.
  readonly excerpt: readonly ExcerptPart[];
}

export interface SearchHits {
  readonly hits: readonly SearchHit[];
  readonly typesenseMs: number;
}

export type SearchFailure = UnavailableReason | 'rejected';

export type SearchResult =
  | { readonly ok: true; readonly value: SearchHits }
  | {
      readonly ok: false;
      readonly error: { readonly code: 'search.unavailable'; readonly reason: SearchFailure };
    };

export interface PublishedSearch {
  searchPublished(tenant: TenantRef, pin: SearchPin, query: SearchQuery): Promise<SearchResult>;
}

export interface PublishedSearchDeps {
  readonly client: TypesenseClient;
  // The parent key: search only, public collections only. It never leaves this process; each
  // call hands Typesense a scoped key made from it.
  readonly searchKey: string;
  readonly buildQuery?: QueryBuilder;
  readonly logger?: SearchLogger;
  readonly now?: () => number;
  readonly keyTtlSeconds?: number;
}

export const KEY_TTL_SECONDS = 60;

const hitSchema = z.object({
  document: z.object({
    organization_id: z.string(),
    project_id: z.string(),
    node_id: z.string(),
    path: z.string().startsWith('/').max(2048),
    title: z.string().max(1024),
  }),
  highlight: z.object({ body: z.object({ snippet: z.string() }).optional() }).optional(),
});

const answerSchema = z.object({ hits: z.array(hitSchema) });

export function excerptOf(snippet: string | undefined): readonly ExcerptPart[] {
  if (snippet === undefined || snippet === '') return [];
  const parts: ExcerptPart[] = [];
  let rest = snippet;
  while (rest !== '') {
    const start = rest.indexOf(MARK_START);
    if (start === -1) {
      parts.push({ text: rest.replaceAll(MARK_END, ''), match: false });
      break;
    }
    if (start > 0)
      parts.push({ text: rest.slice(0, start).replaceAll(MARK_END, ''), match: false });
    const afterStart = rest.slice(start + MARK_START.length);
    const end = afterStart.indexOf(MARK_END);
    const marked = end === -1 ? afterStart : afterStart.slice(0, end);
    const clean = marked.replaceAll(MARK_START, '');
    if (clean !== '') parts.push({ text: clean, match: true });
    rest = end === -1 ? '' : afterStart.slice(end + MARK_END.length);
  }
  return parts.filter((part) => part.text !== '');
}

function publicNodeId(raw: string): string | null {
  try {
    return toPublicId('nod', idOf('nod', raw));
  } catch {
    return null;
  }
}

export function createPublishedSearch(deps: PublishedSearchDeps): PublishedSearch {
  const buildQuery = deps.buildQuery ?? buildPublishedQuery;
  const logger = deps.logger ?? noopLogger;
  const now = deps.now ?? Date.now;
  const ttl = deps.keyTtlSeconds ?? KEY_TTL_SECONDS;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 3600) {
    throw new RangeError('keyTtlSeconds must be between 1 and 3600');
  }
  if (deps.searchKey.length < 16) throw new RangeError('searchKey is too short to be a real key');

  const fail = (reason: SearchFailure): SearchResult => ({
    ok: false,
    error: { code: 'search.unavailable', reason },
  });

  return Object.freeze({
    async searchPublished(
      tenant: TenantRef,
      pin: SearchPin,
      query: SearchQuery,
    ): Promise<SearchResult> {
      const ids = {
        organizationId: toPublicId('org', tenant.organizationId),
        projectId: toPublicId('prj', tenant.projectId),
      };
      // Built here from the tenant alone, never from the request the builder returns.
      const params: ScopedKeyParams = {
        filter_by: publishedFilter(tenant, pin),
        expires_at: Math.floor(now() / 1000) + ttl,
        filter_curated_hits: true,
        enable_overrides: false,
        limit_hits: MAX_HITS,
      };
      const key = generateScopedKey(deps.searchKey, params);
      const request = buildQuery(tenant, pin, query);
      const started = performance.now();
      let answer;
      try {
        answer = await deps.client.call({
          method: 'GET',
          path: `/collections/${encodeURIComponent(request.collection)}/documents/search`,
          key,
          query: request.params,
          idempotent: true,
        });
      } catch (error) {
        if (error instanceof SearchUnavailableError) {
          logger.warn('search.typesense_unavailable', { ...ids, reason: error.reason });
          return fail(error.reason);
        }
        throw error;
      }
      const typesenseMs = Math.round(performance.now() - started);
      // A site with nothing indexed yet has no collection: an empty answer, not an outage.
      if (answer.status === 404) return { ok: true, value: { hits: [], typesenseMs } };
      if (answer.status !== 200) {
        logger.error('search.typesense_rejected', { ...ids, status: answer.status });
        return fail('rejected');
      }
      let body: unknown;
      try {
        body = JSON.parse(answer.text);
      } catch {
        logger.error('search.typesense_bad_response', ids);
        return fail('bad_response');
      }
      const parsed = answerSchema.safeParse(body);
      if (!parsed.success) {
        logger.error('search.typesense_bad_response', ids);
        return fail('bad_response');
      }
      const hits: SearchHit[] = [];
      let foreign = 0;
      for (const { document, highlight } of parsed.data.hits.slice(0, MAX_HITS)) {
        // A third check after the key and the filter. If it ever fires, both of those failed.
        if (
          document.organization_id !== tenant.organizationId ||
          document.project_id !== tenant.projectId
        ) {
          foreign += 1;
          continue;
        }
        const nodeId = publicNodeId(document.node_id);
        if (nodeId === null) continue;
        hits.push({
          nodeId,
          path: document.path,
          title: document.title,
          excerpt: excerptOf(highlight?.body?.snippet),
        });
      }
      if (foreign > 0) logger.error('search.foreign_hit', { ...ids, count: foreign });
      return { ok: true, value: { hits, typesenseMs } };
    },
  });
}

import type { TenantRef } from '@drefyn/tenancy';
import type { SearchPin } from './pin.ts';
import type { SearchQuery } from './query.ts';

export const MAX_HITS = 20;

// One public collection per site. Protected pages never go in one of these, and the parent key
// behind public scoped keys reaches nothing else.
export const PUBLIC_COLLECTION_PATTERN = '^docs_pub_[0-9a-f]{32}$';

const HEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// TenantRef ids are canonical lowercase UUIDs already; checked again because the name lands in
// a URL path and a key's collection list.
export function publicCollectionFor(tenant: TenantRef): string {
  if (!HEX_UUID.test(tenant.projectId)) throw new RangeError('project id is not a canonical UUID');
  return `docs_pub_${tenant.projectId.replaceAll('-', '')}`;
}

// Backticks make Typesense read the value as one literal. Every value here is a UUID, a version
// key or a locale tag, none of which can hold a backtick, so this never has to escape one.
const literal = (value: string): string => {
  if (value.includes('`')) throw new RangeError('filter value holds a backtick');
  return `\`${value}\``;
};

// The tenant wall. The scoped key embeds this, and the query builder below sends it again, so
// both would have to be wrong at once for a foreign document to come back.
export function publishedFilter(tenant: TenantRef, pin: SearchPin): string {
  return [
    `organization_id:=${literal(tenant.organizationId)}`,
    `project_id:=${literal(tenant.projectId)}`,
    `version_key:=${literal(pin.version)}`,
    `locale:=${literal(pin.locale)}`,
    'visibility:=public',
  ].join(' && ');
}

// Highlight markers from the private use area. Indexed text has them stripped, so any marker in
// a snippet came from Typesense.
export const MARK_START = '\u{E000}';
export const MARK_END = '\u{E001}';

export interface SearchRequest {
  readonly collection: string;
  readonly params: Readonly<Record<string, string>>;
}

// Builds the Typesense request for one public search. A port, so a test can swap in a builder
// that forgets the tenant and prove the scoped key still holds.
export type QueryBuilder = (tenant: TenantRef, pin: SearchPin, query: SearchQuery) => SearchRequest;

export const buildPublishedQuery: QueryBuilder = (tenant, pin, query) => ({
  collection: publicCollectionFor(tenant),
  params: {
    q: query,
    query_by: 'title,headings,body',
    query_by_weights: '4,2,1',
    filter_by: publishedFilter(tenant, pin),
    per_page: String(MAX_HITS),
    page: '1',
    include_fields: 'organization_id,project_id,node_id,path,title',
    highlight_fields: 'body',
    highlight_start_tag: MARK_START,
    highlight_end_tag: MARK_END,
    snippet_threshold: '30',
    highlight_affix_num_tokens: '8',
  },
});

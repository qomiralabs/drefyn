import type { PublishedSchema } from '@drefyn/db';
import type { TenantRef } from '@drefyn/tenancy';
import { sql, type RawBuilder, type Transaction } from 'kysely';
import { z } from 'zod';
import { B, K1 } from './bm25.ts';
import type { RetrievalConfig } from './config.ts';
import type { PageKey } from './input.ts';

export type ReaderTx = Transaction<PublishedSchema>;

export type Caps = Pick<
  RetrievalConfig,
  'maxQueryTerms' | 'commonTermPercent' | 'maxPostings' | 'maxScoredCandidates'
>;

// Both settings are local to the read transaction, so a pooled connection never hands either
// to the next tenant. A generic plan for the search measured about three times slower than a
// custom one, because the caps and the lexemes decide which index path is cheap.
export async function prepareRead(tx: ReaderTx, timeoutMs: number): Promise<void> {
  await sql`
    select set_config('plan_cache_mode', 'force_custom_plan', true),
           set_config('statement_timeout', ${String(timeoutMs)}, true)`.execute(tx);
}

export interface SearchArgs {
  readonly label: string;
  readonly query: string;
  readonly limit: number;
  readonly pathPrefix: string | null;
  readonly scored: boolean;
  readonly caps: Caps;
}

// Constants of the formula, not input, so they can be part of the text.
const k1 = sql.raw(`${String(K1)}::float8`);
const k1Plus1 = sql.raw(`${String(K1 + 1)}::float8`);
const b = sql.raw(`${String(B)}::float8`);
const oneMinusB = sql.raw(`${String(1 - B)}::float8`);

// One lexeme's BM25 term for one chunk. q is the question lexeme, s the project's totals.
const term = (alias: string) => {
  const tf = sql.ref(`${alias}.tf`);
  const length = sql.ref(`${alias}.chunk_length`);
  return sql`(q.idf * ${tf} * ${k1Plus1} / (${tf} + ${k1} * (${oneMinusB} + ${b} * ${length} / s.avglen)))`;
};

// Ordering on the score rounded to 9 places, then the chunk id, so float noise in a sum can
// never reorder two chunks with the same text between two runs.
const byScore = (score: RawBuilder<unknown>, chunkId: RawBuilder<unknown>) =>
  sql`round((${score})::numeric, 9) desc, ${chunkId}`;

// Retrieval in one statement: the question's lexemes, BM25 from the term tables, a capped set
// of candidates, the full score for the best of them, then the top hits joined to their text.
// Every read names the tenant, so each is a range of a tenant leading index, and RLS holds
// the same line underneath.
export function searchStatement(tenant: TenantRef, args: SearchArgs): RawBuilder<unknown> {
  const org = sql`${tenant.organizationId}::uuid`;
  const prj = sql`${tenant.projectId}::uuid`;
  const label = sql`${args.label}::text`;
  const { caps } = args;
  const maxPostings = sql`${caps.maxPostings}::int`;
  const prefix =
    args.pathPrefix === null
      ? sql`true`
      : sql`exists (
          select 1 from app.published_chunks pc
           where pc.organization_id = ${org} and pc.project_id = ${prj}
             and pc.id = sc.chunk_id and pc.is_current
             and (pc.page_path = ${args.pathPrefix}
                  or starts_with(pc.page_path, ${args.pathPrefix.endsWith('/') ? args.pathPrefix : `${args.pathPrefix}/`})))`;
  // The share of the question's weight the top hit holds. Absent lexemes count with their
  // full weight, which is what lets the gate refuse a question the docs cannot answer.
  const coverage = args.scored
    ? sql`coalesce((
        select sum(coverage_lexeme.idf) filter (where exists (
                 select 1 from terms t
                  where t.lexeme = coverage_lexeme.lexeme
                    and t.chunk_id = (select chunk_id from top
                                       order by ${byScore(sql`score`, sql`chunk_id`)} limit 1)))
               / nullif(sum(coverage_lexeme.idf), 0)
          from q as coverage_lexeme), 0)::float8`
    : sql`null::float8`;
  return sql`
    with s as (
      select t.chunk_count::float8 as n,
             greatest(t.total_length, 1)::float8 / t.chunk_count as avglen
        from app.published_project_term_totals t
       where t.organization_id = ${org} and t.project_id = ${prj} and t.version_label = ${label}
         and t.chunk_count > 0
    ),
    -- No tsquery parsing of the question: its words are only ever lexemes compared by equality.
    ql as (
      select u.lexeme
        from unnest(to_tsvector('simple'::regconfig, ${args.query}::text)) u
       order by coalesce(u.positions[1], 0), u.lexeme
       limit ${caps.maxQueryTerms}::int
    ),
    q as materialized (
      select ql.lexeme, coalesce(d.df, 0) as df,
             ln(1 + (s.n - coalesce(d.df, 0) + 0.5) / (coalesce(d.df, 0) + 0.5)) as idf
        from ql cross join s
        left join app.published_term_stats d
          on d.organization_id = ${org} and d.project_id = ${prj} and d.version_label = ${label}
         and d.lexeme = ql.lexeme
    ),
    -- A lexeme in more than the common share of chunks still scores, but picks nothing: its
    -- postings are most of the project and its weight is low.
    eligible as (
      select lexeme, df,
             sum(df) over (order by df, lexeme) as cum,
             row_number() over (order by df, lexeme) as rn
        from q
       where df > 0 and df::bigint * 100 <= ${caps.commonTermPercent}::int * (select n from s)
    ),
    -- Rarest first while the postings fit the cap; the rarest always picks, and when none is
    -- eligible the rarest of all picks alone.
    pick as materialized (
      select lexeme, least(df, ${maxPostings}) as take, df <= ${maxPostings} as full_read
        from eligible
       where cum <= ${maxPostings} or rn = 1
      union all
      select r.lexeme, least(r.df, ${maxPostings}), r.df <= ${maxPostings}
        from (select lexeme, df from q where df > 0 order by df, lexeme limit 1) r
       where not exists (select 1 from eligible)
    ),
    -- Highest term frequency first, so a lexeme read past the cap keeps its best postings.
    reads as materialized (
      select p.chunk_id, pk.lexeme, p.tf, p.chunk_length
        from pick pk
        cross join lateral (
          select t.chunk_id, t.tf, t.chunk_length from app.published_chunk_terms t
           where t.organization_id = ${org} and t.project_id = ${prj}
             and t.version_label = ${label} and t.lexeme = pk.lexeme
           order by t.tf desc, t.chunk_id
           limit pk.take) p
    ),
    cand as materialized (
      select r.chunk_id, min(r.chunk_length) as chunk_length
        from reads r join q on q.lexeme = r.lexeme cross join s
       group by r.chunk_id
       order by ${byScore(sql`sum(${term('r')})`, sql`r.chunk_id`)}
       limit ${caps.maxScoredCandidates}::int
    ),
    -- One primary key probe per kept candidate and lexeme not already read in full. The
    -- lateral limit keeps the planner from scanning a common lexeme's whole postings list.
    probe as (
      select c.chunk_id, q.lexeme, t.tf, c.chunk_length
        from cand c cross join q
        left join lateral (
          select t.tf from app.published_chunk_terms t
           where t.organization_id = ${org} and t.project_id = ${prj}
             and t.version_label = ${label} and t.lexeme = q.lexeme and t.chunk_id = c.chunk_id
           limit 1) t on true
       where q.df > 0 and t.tf is not null
         and not exists (select 1 from pick where pick.lexeme = q.lexeme and pick.full_read)
    ),
    terms as materialized (
      select r.chunk_id, r.lexeme, r.tf, r.chunk_length from reads r
       where r.chunk_id in (select chunk_id from cand)
      union
      select chunk_id, lexeme, tf, chunk_length from probe
    ),
    scored as (
      select t.chunk_id, sum(${term('t')}) as score
        from terms t join q on q.lexeme = t.lexeme cross join s
       group by t.chunk_id
    ),
    top as materialized (
      select sc.chunk_id, sc.score from scored sc
       where ${prefix}
       order by ${byScore(sql`sc.score`, sql`sc.chunk_id`)}
       limit ${args.limit}::int
    )
    select
      (select n from s)::bigint as chunk_count,
      (select count(*) from q)::int as lexemes,
      (select count(*) from cand)::int as candidates,
      (select count(*) from reads)::int as postings,
      (select max(v.published_at) from app.published_versions v
        where v.organization_id = ${org} and v.project_id = ${prj} and v.is_current) as published_at,
      ${coverage} as coverage,
      coalesce((
        select json_agg(json_build_object(
                 'chunk_id', c.id, 'node_id', c.node_id, 'version_id', c.version_id,
                 'path', c.page_path, 'title', c.title, 'heading_path', c.heading_path,
                 'text', c.body, 'score', top.score)
               order by ${byScore(sql`top.score`, sql`top.chunk_id`)})
          from top
          join app.published_chunks c
            on c.organization_id = ${org} and c.project_id = ${prj}
           and c.id = top.chunk_id and c.is_current), '[]'::json) as hits`;
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid = z.string().regex(CANONICAL_UUID);

// The driver hands back a Date for timestamptz; a string is accepted too.
const instant = z
  .union([z.date(), z.string()])
  .transform((value) => (value instanceof Date ? value : new Date(value)))
  .refine((at) => !Number.isNaN(at.getTime()))
  .transform((at) => at.toISOString());

const searchRowSchema = z.object({
  chunk_count: z.union([z.string().regex(/^[0-9]+$/), z.number().int(), z.null()]),
  lexemes: z.number().int(),
  candidates: z.number().int(),
  postings: z.number().int(),
  published_at: instant.nullable(),
  coverage: z.number().nullable(),
  hits: z.array(
    z.object({
      chunk_id: uuid,
      node_id: uuid,
      version_id: uuid,
      path: z.string(),
      title: z.string(),
      heading_path: z.array(z.string()),
      text: z.string(),
      score: z.number(),
    }),
  ),
});

export interface SearchHitRow {
  readonly chunkId: string;
  readonly nodeId: string;
  readonly versionId: string;
  readonly path: string;
  readonly title: string;
  readonly headingPath: readonly string[];
  readonly text: string;
  readonly score: number;
}

export interface SearchRow {
  readonly chunkCount: number | null;
  readonly lexemes: number;
  readonly candidates: number;
  readonly postings: number;
  readonly publishedAt: string | null;
  readonly coverage: number | null;
  readonly hits: readonly SearchHitRow[];
}

export function parseSearchRow(row: unknown): SearchRow | null {
  const parsed = searchRowSchema.safeParse(row);
  if (!parsed.success) return null;
  const data = parsed.data;
  return {
    chunkCount: data.chunk_count === null ? null : Number(data.chunk_count),
    lexemes: data.lexemes,
    candidates: data.candidates,
    postings: data.postings,
    publishedAt: data.published_at,
    coverage: data.coverage,
    hits: data.hits.map((hit) => ({
      chunkId: hit.chunk_id,
      nodeId: hit.node_id,
      versionId: hit.version_id,
      path: hit.path,
      title: hit.title,
      headingPath: hit.heading_path,
      text: hit.text,
      score: hit.score,
    })),
  };
}

// One page's current sections in order. Rows the public reader cannot see are simply absent,
// so a protected page, a draft and another tenant's page all read as no rows.
export function pageStatement(tenant: TenantRef, by: PageKey): RawBuilder<unknown> {
  const org = sql`${tenant.organizationId}::uuid`;
  const prj = sql`${tenant.projectId}::uuid`;
  const match =
    'nodeId' in by ? sql`c.node_id = ${by.nodeId}::uuid` : sql`c.page_path = ${by.path}::text`;
  return sql`
    with page as (
      select c.node_id from app.published_chunks c
       where c.organization_id = ${org} and c.project_id = ${prj} and c.is_current and ${match}
       order by c.node_id
       limit 1
    )
    select c.node_id, c.version_id, c.page_path as path, c.title, c.heading_path,
           c.body as text, v.published_at
      from page
      join app.published_chunks c
        on c.organization_id = ${org} and c.project_id = ${prj}
       and c.node_id = page.node_id and c.is_current
      join app.published_versions v
        on v.organization_id = ${org} and v.project_id = ${prj}
       and v.node_id = c.node_id and v.version_id = c.version_id
     order by c.ord`;
}

const pageRowSchema = z.object({
  node_id: uuid,
  version_id: uuid,
  path: z.string(),
  title: z.string(),
  heading_path: z.array(z.string()),
  text: z.string(),
  published_at: instant,
});

export interface PageRow {
  readonly nodeId: string;
  readonly versionId: string;
  readonly path: string;
  readonly title: string;
  readonly headingPath: readonly string[];
  readonly text: string;
  readonly publishedAt: string;
}

export function parsePageRows(rows: readonly unknown[]): readonly PageRow[] | null {
  const parsed = z.array(pageRowSchema).safeParse(rows);
  if (!parsed.success) return null;
  return parsed.data.map((row) => ({
    nodeId: row.node_id,
    versionId: row.version_id,
    path: row.path,
    title: row.title,
    headingPath: row.heading_path,
    text: row.text,
    publishedAt: row.published_at,
  }));
}

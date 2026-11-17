import type { TenantRef } from '@drefyn/tenancy';
import { sql } from 'kysely';
import type { EngineTx } from './store.ts';
import { MAX_TREE_LEVELS } from './tree.ts';

export type Visibility = 'public' | 'protected';

// Every published set is 'latest' until named docs versions add their own labels.
export const LATEST_LABEL = 'latest';

// What a node's published chunks should become: one version's chunks at one visibility, or
// none when the node is unpublished.
export interface ChunkTarget {
  readonly versionId: string;
  readonly visibility: Visibility;
}

// Counts only, for the publish log line. Never text or lexemes, which are fragments of a page.
export interface ChunkCopy {
  readonly chunks: number;
  readonly publicChunks: number;
  readonly postingsAdded: number;
  readonly postingsRemoved: number;
  readonly lexemesChanged: number;
}

export interface TermChange {
  // Chunks whose postings leave the term tables, and chunks whose postings enter them.
  readonly gone: readonly string[];
  readonly added: readonly string[];
}

// A chunk that stays public and current keeps its postings: its text cannot change under the
// same id, so removing and adding them back would only churn the statistics.
export function termChange(before: readonly string[], after: readonly string[]): TermChange {
  const was = new Set(before);
  const now = new Set(after);
  return {
    gone: [...was].filter((id) => !now.has(id)).sort(),
    added: [...now].filter((id) => !was.has(id)).sort(),
  };
}

const lockName = (tenant: TenantRef) => `engine.terms:${tenant.organizationId}:${tenant.projectId}`;

interface ChunkRow {
  readonly id: string;
  readonly visibility: string;
}

interface TermCounts {
  readonly removed: number | string;
  readonly added: number | string;
  readonly lexemes: number | string;
}

const publicIds = (rows: readonly ChunkRow[]) =>
  rows.filter((row) => row.visibility === 'public').map((row) => row.id);

// The public current chunks of a node right now, before anything moves.
async function currentPublic(tx: EngineTx, tenant: TenantRef, nodeId: string) {
  const { rows } = await sql<ChunkRow>`
    select id::text as id, visibility from app.published_chunks
     where organization_id = ${tenant.organizationId}::uuid
       and project_id = ${tenant.projectId}::uuid
       and node_id = ${nodeId}::uuid
       and is_current`.execute(tx);
  return publicIds(rows);
}

// Path and title are resolved here, at publish, so a reader never joins a draft table. The path
// is the slug chain from the root; a node with no slug stands in with its id. The title is the
// version's title field, else its first heading, else the slug.
async function copyVersion(
  tx: EngineTx,
  tenant: TenantRef,
  nodeId: string,
  target: ChunkTarget,
): Promise<readonly ChunkRow[]> {
  const { rows } = await sql<ChunkRow>`
    with recursive chain (id, parent_id, slug, level) as (
      select n.id, n.parent_id, n.slug, 0 from app.nodes n
       where n.organization_id = ${tenant.organizationId}::uuid
         and n.project_id = ${tenant.projectId}::uuid
         and n.id = ${nodeId}::uuid
      union all
      select n.id, n.parent_id, n.slug, chain.level + 1 from app.nodes n
        join chain on n.id = chain.parent_id
       where n.organization_id = ${tenant.organizationId}::uuid
         and n.project_id = ${tenant.projectId}::uuid
         and chain.level < ${MAX_TREE_LEVELS}
    ),
    page as (
      select '/' || (select string_agg(coalesce(nullif(slug, ''), id::text), '/' order by level desc)
                       from chain) as page_path,
             coalesce(
               (select nullif(btrim(v.fields ->> 'title'), '') from app.node_versions v
                 where v.organization_id = ${tenant.organizationId}::uuid
                   and v.project_id = ${tenant.projectId}::uuid
                   and v.id = ${target.versionId}::uuid
                   and jsonb_typeof(v.fields -> 'title') = 'string'),
               (select nullif(btrim(c.heading_path[1]), '') from app.chunks c
                 where c.organization_id = ${tenant.organizationId}::uuid
                   and c.project_id = ${tenant.projectId}::uuid
                   and c.version_id = ${target.versionId}::uuid
                 order by c.ord limit 1),
               (select nullif(slug, '') from chain where level = 0),
               '') as title
    )
    insert into app.published_chunks (organization_id, project_id, node_id, version_id, ord,
        page_path, title, heading_path, body, body_sha256, visibility, is_current)
    select c.organization_id, c.project_id, c.node_id, c.version_id, c.ord, page.page_path,
           page.title, c.heading_path, c.body, c.body_sha256, ${target.visibility}, true
      from app.chunks c cross join page
     where c.organization_id = ${tenant.organizationId}::uuid
       and c.project_id = ${tenant.projectId}::uuid
       and c.node_id = ${nodeId}::uuid
       and c.version_id = ${target.versionId}::uuid
     order by c.ord
    on conflict on constraint published_chunks_version_ord_key do update
      set is_current = true, visibility = excluded.visibility, page_path = excluded.page_path,
          title = excluded.title
    returning id::text as id, visibility`.execute(tx);
  return rows;
}

// Only public chunks reach the term tables, and the database refuses any other value there.
const TERM_VISIBILITY = 'public';

// One statement moves the postings and applies the document frequency change, so the counts
// can never disagree with the postings. Upserts run in lexeme order. The caller holds the
// project's term lock, so two publishes never interleave here at all.
async function moveTerms(tx: EngineTx, tenant: TenantRef, change: TermChange) {
  const org = sql`${tenant.organizationId}::uuid`;
  const project = sql`${tenant.projectId}::uuid`;
  const { rows } = await sql<TermCounts>`
    with gone as (
      delete from app.published_chunk_terms t
       where t.organization_id = ${org} and t.project_id = ${project}
         and t.version_label = ${LATEST_LABEL}
         and t.chunk_id = any(${change.gone}::uuid[])
      returning t.lexeme, t.tf
    ),
    added as (
      insert into app.published_chunk_terms (organization_id, project_id, version_label, lexeme,
          chunk_id, tf, chunk_length, visibility)
      select c.organization_id, c.project_id, ${LATEST_LABEL}, u.lexeme, c.id,
             coalesce(cardinality(u.positions), 1), size.n, ${TERM_VISIBILITY}
        from app.published_chunks c
        cross join lateral (
          select coalesce(sum(coalesce(cardinality(p.positions), 1)), 0)::integer as n
            from unnest(c.search) p
        ) size
        cross join lateral unnest(c.search) u
       where c.organization_id = ${org} and c.project_id = ${project}
         and c.id = any(${change.added}::uuid[])
       order by u.lexeme, c.id
      returning lexeme, tf
    ),
    delta as (
      select lexeme, sum(n)::integer as n
        from (select lexeme, -1 as n from gone union all select lexeme, 1 from added) moved
       group by lexeme
      having sum(n) <> 0
    ),
    -- Every data modifying step runs whether or not the final select reads it.
    raised as (
      insert into app.published_term_stats (organization_id, project_id, version_label, lexeme, df,
          visibility)
      select ${org}, ${project}, ${LATEST_LABEL}, lexeme, n, ${TERM_VISIBILITY} from delta
       where n > 0
       order by lexeme
      on conflict on constraint published_term_stats_pkey do update
        set df = app.published_term_stats.df + excluded.df
      returning 1
    ),
    lowered as (
      update app.published_term_stats s set df = s.df + d.n
        from delta d
       where d.n < 0 and s.organization_id = ${org} and s.project_id = ${project}
         and s.version_label = ${LATEST_LABEL} and s.lexeme = d.lexeme and s.df + d.n > 0
      returning 1
    ),
    emptied as (
      delete from app.published_term_stats s
       using delta d
       where d.n < 0 and s.organization_id = ${org} and s.project_id = ${project}
         and s.version_label = ${LATEST_LABEL} and s.lexeme = d.lexeme and s.df + d.n <= 0
      returning 1
    ),
    -- greatest keeps a drifted count from failing every later publish; the drift check
    -- rebuilds it.
    totals as (
      update app.published_project_term_totals
         set chunk_count = greatest(0, chunk_count + ${change.added.length - change.gone.length}),
             total_length = greatest(0, total_length + (select coalesce(sum(tf), 0) from added)
                                                     - (select coalesce(sum(tf), 0) from gone))
       where organization_id = ${org} and project_id = ${project}
         and version_label = ${LATEST_LABEL}
      returning 1
    )
    select (select count(*) from gone) as removed,
           (select count(*) from added) as added,
           (select count(*) from delta) as lexemes`.execute(tx);
  const counts = rows[0];
  return {
    removed: Number(counts?.removed ?? 0),
    added: Number(counts?.added ?? 0),
    lexemes: Number(counts?.lexemes ?? 0),
  };
}

// Runs in the publish transaction, after published_versions is written: flips the node's
// current chunks to the target version and keeps the term tables equal to the public current
// chunks. Nothing here commits on its own, so a later failure rolls all of it back.
export async function writePublishedChunks(
  tx: EngineTx,
  tenant: TenantRef,
  nodeId: string,
  target: ChunkTarget | null,
): Promise<ChunkCopy> {
  const before = await currentPublic(tx, tenant, nodeId);
  await sql`
    update app.published_chunks set is_current = false
     where organization_id = ${tenant.organizationId}::uuid
       and project_id = ${tenant.projectId}::uuid
       and node_id = ${nodeId}::uuid
       and is_current
       ${target === null ? sql`` : sql`and version_id <> ${target.versionId}::uuid`}`.execute(tx);
  const copied = target === null ? [] : await copyVersion(tx, tenant, nodeId, target);
  const after = publicIds(copied);
  const change = termChange(before, after);
  const counts = { chunks: copied.length, publicChunks: after.length };
  if (change.gone.length === 0 && change.added.length === 0) {
    return { ...counts, postingsAdded: 0, postingsRemoved: 0, lexemesChanged: 0 };
  }
  // Every publish that moves terms in a project queues here, so statistics see one change at a
  // time and two publishes cannot deadlock on each other's lexemes.
  await sql`select pg_advisory_xact_lock(hashtextextended(${lockName(tenant)}, 0))`.execute(tx);
  await sql`
    insert into app.published_project_term_totals (organization_id, project_id, version_label,
        chunk_count, total_length, visibility)
    values (${tenant.organizationId}::uuid, ${tenant.projectId}::uuid, ${LATEST_LABEL}, 0, 0,
            ${TERM_VISIBILITY})
    on conflict on constraint published_project_term_totals_pkey do nothing`.execute(tx);
  const moved = await moveTerms(tx, tenant, change);
  return {
    ...counts,
    postingsAdded: moved.added,
    postingsRemoved: moved.removed,
    lexemesChanged: moved.lexemes,
  };
}

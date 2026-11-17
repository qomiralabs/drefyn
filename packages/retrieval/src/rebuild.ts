import { withTenant, type Database, type TenantSchema } from '@drefyn/db';
import type { TenantRef } from '@drefyn/tenancy';
import { sql, type Transaction } from 'kysely';
import { LATEST } from './input.ts';
import type { RetrievalLogger, RetrievalResult } from './retrieval.ts';

export type TermTx = Transaction<TenantSchema>;

// The app role, under the tenant: the term tables are written, never read, through it.
export interface TermStore {
  write<T>(tenant: TenantRef, work: (tx: TermTx) => Promise<T>): Promise<T>;
}

export const appTermStore = (
  db: Database,
  options: { readonly timeoutMs?: number } = {},
): TermStore => ({
  write: (tenant, work) => withTenant(db, tenant, work, options),
});

export interface TermRebuild {
  // Recomputes the three term tables for one project from its public current chunks, in one
  // transaction. Running it twice gives the same tables.
  rebuildTermStats(
    tenant: TenantRef,
  ): Promise<RetrievalResult<{ chunks: number; lexemes: number }, 'retrieval.unavailable'>>;
}

export interface TermRebuildDeps {
  readonly store: TermStore;
  readonly logger?: RetrievalLogger;
}

// The publish writer's lock name, so a rebuild and a publish in one project queue on each
// other instead of interleaving their statistics.
const lockName = (tenant: TenantRef) => `engine.terms:${tenant.organizationId}:${tenant.projectId}`;

const count = async (tx: TermTx, query: ReturnType<typeof sql<{ n: number }>>) =>
  (await query.execute(tx)).rows[0]?.n ?? 0;

export function createTermRebuild(deps: TermRebuildDeps): TermRebuild {
  const logger = deps.logger;
  return {
    async rebuildTermStats(tenant) {
      const started = performance.now();
      const org = sql`${tenant.organizationId}::uuid`;
      const prj = sql`${tenant.projectId}::uuid`;
      const ids = { organizationId: tenant.organizationId, projectId: tenant.projectId };
      try {
        const counts = await deps.store.write(tenant, async (tx) => {
          await sql`select pg_advisory_xact_lock(hashtextextended(${lockName(tenant)}, 0))`.execute(
            tx,
          );
          for (const table of [
            sql`app.published_chunk_terms`,
            sql`app.published_term_stats`,
            sql`app.published_project_term_totals`,
          ]) {
            await sql`
              delete from ${table}
               where organization_id = ${org} and project_id = ${prj}
                 and version_label = ${LATEST}`.execute(tx);
          }
          // Term frequency is the position count; length is the sum over the chunk, as
          // publish writes them. Only public current chunks, and the database refuses any other
          // visibility on these rows.
          const postings = await count(
            tx,
            sql<{ n: number }>`
              with added as (
                insert into app.published_chunk_terms (organization_id, project_id,
                    version_label, lexeme, chunk_id, tf, chunk_length, visibility)
                select c.organization_id, c.project_id, ${LATEST}, u.lexeme, c.id,
                       coalesce(cardinality(u.positions), 1), size.n, 'public'
                  from app.published_chunks c
                  cross join lateral (
                    select coalesce(sum(coalesce(cardinality(p.positions), 1)), 0)::integer as n
                      from unnest(c.search) p
                  ) size
                  cross join lateral unnest(c.search) u
                 where c.organization_id = ${org} and c.project_id = ${prj}
                   and c.is_current and c.visibility = 'public'
                 order by u.lexeme, c.id
                returning 1
              )
              select count(*)::int as n from added`,
          );
          const lexemes = await count(
            tx,
            sql<{ n: number }>`
              with added as (
                insert into app.published_term_stats (organization_id, project_id,
                    version_label, lexeme, df, visibility)
                select ${org}, ${prj}, ${LATEST}, t.lexeme, count(*)::integer, 'public'
                  from app.published_chunk_terms t
                 where t.organization_id = ${org} and t.project_id = ${prj}
                   and t.version_label = ${LATEST}
                 group by t.lexeme
                 order by t.lexeme
                returning 1
              )
              select count(*)::int as n from added`,
          );
          const chunks = await count(
            tx,
            sql<{ n: number }>`
              with added as (
                insert into app.published_project_term_totals (organization_id, project_id,
                    version_label, chunk_count, total_length, visibility)
                select ${org}, ${prj}, ${LATEST}, count(*)::integer, coalesce(sum(x.n), 0), 'public'
                  from (
                    select (select coalesce(sum(coalesce(cardinality(p.positions), 1)), 0)
                              from unnest(c.search) p) as n
                      from app.published_chunks c
                     where c.organization_id = ${org} and c.project_id = ${prj}
                       and c.is_current and c.visibility = 'public'
                  ) x
                returning chunk_count
              )
              select coalesce(max(chunk_count), 0)::int as n from added`,
          );
          return { chunks, lexemes, postings };
        });
        logger?.info('retrieval.term_rebuild', {
          ...ids,
          chunks: counts.chunks,
          lexemes: counts.lexemes,
          postings: counts.postings,
          ms: Math.round(performance.now() - started),
        });
        return { ok: true, value: { chunks: counts.chunks, lexemes: counts.lexemes } };
      } catch {
        logger?.warn('retrieval.term_rebuild_failed', {
          ...ids,
          ms: Math.round(performance.now() - started),
        });
        return { ok: false, error: 'retrieval.unavailable' };
      }
    },
  };
}

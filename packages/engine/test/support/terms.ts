import { randomUUID } from 'node:crypto';
import type { Database } from '@drefyn/db';
import { withTenant } from '@drefyn/db';
import type { TenantRef } from '@drefyn/tenancy';
import { sql, type RawBuilder } from 'kysely';
import {
  writePublishedChunks,
  type ChunkCopy,
  type ChunkTarget,
} from '../../src/published-chunks.ts';
import type { EngineTx } from '../../src/store.ts';
import { admin, type Seeded } from './fixture.ts';

const text = (value: string) => `'${value.replaceAll("'", "''")}'`;

export interface DraftChunk {
  readonly headingPath: readonly string[];
  readonly body: string;
}

export interface NodeOptions {
  readonly slug?: string;
  readonly parentId?: string;
  readonly title?: string;
}

export interface SeededNode {
  readonly nodeId: string;
  readonly versionIds: readonly string[];
}

function nodeSql(
  seeded: Seeded,
  versions: readonly (readonly DraftChunk[])[],
  options: NodeOptions,
): { readonly node: SeededNode; readonly statements: string } {
  const { organization: org, project: prj, typeId } = seeded;
  const nodeId = randomUUID();
  const versionIds = versions.map(() => randomUUID());
  const fields = options.title === undefined ? '{}' : JSON.stringify({ title: options.title });
  const rows = versions.flatMap((chunks, at) => {
    const versionId = versionIds[at] ?? '';
    return [
      `insert into app.node_versions (id, organization_id, project_id, node_id, seq,
          schema_version, ast_version, origin, actor, content, content_sha256, fields)
        values ('${versionId}', '${org}', '${prj}', '${nodeId}', ${String(at + 1)}, 1, 1, 'human',
          '{"kind":"system","job":"test"}', '{}', sha256('${versionId}'::bytea), ${text(fields)});`,
      ...chunks.map(
        (chunk, ord) =>
          `insert into app.chunks (organization_id, project_id, node_id, version_id, ord,
              block_path, heading_path, body, body_sha256)
            values ('${org}', '${prj}', '${nodeId}', '${versionId}', ${String(ord)}, '${String(ord)}',
              array[${chunk.headingPath.map(text).join(', ')}]::text[], ${text(chunk.body)},
              sha256(convert_to(${text(chunk.body)}, 'UTF8')));`,
      ),
    ];
  });
  const statements = `
insert into app.nodes (id, organization_id, project_id, family, type_id, parent_id, slug,
    order_key, lifecycle)
  values ('${nodeId}', '${org}', '${prj}', 'docs_page', '${typeId}',
    ${options.parentId === undefined ? 'null' : `'${options.parentId}'`},
    ${options.slug === undefined ? 'null' : text(options.slug)}, 'a${nodeId.slice(0, 8)}', 'draft');
${rows.join('\n')}`;
  return { node: { nodeId, versionIds }, statements };
}

// Nodes with saved versions whose chunks are given, written as the superuser in one call so a
// property run does not wait on the parse host. Each version's chunks are what chunk at write
// would have stored.
export async function nodesWithVersions(
  seeded: Seeded,
  pages: readonly (readonly (readonly DraftChunk[])[])[],
): Promise<readonly SeededNode[]> {
  const built = pages.map((versions) => nodeSql(seeded, versions, {}));
  await admin(built.map((b) => b.statements).join('\n'));
  return built.map((b) => b.node);
}

export async function nodeWithVersions(
  seeded: Seeded,
  versions: readonly (readonly DraftChunk[])[],
  options: NodeOptions = {},
): Promise<SeededNode> {
  const { node, statements } = nodeSql(seeded, versions, options);
  await admin(statements);
  return node;
}

// The published_versions write the publish transaction makes before the chunk copy: the old
// current row goes, the target comes back as current.
export async function writeVersionRow(
  tx: EngineTx,
  seeded: Seeded,
  nodeId: string,
  versionId: string | null,
): Promise<void> {
  const { tenant, typeId } = seeded;
  await sql`
    update app.published_versions set is_current = false
     where organization_id = ${tenant.organizationId}::uuid
       and project_id = ${tenant.projectId}::uuid
       and node_id = ${nodeId}::uuid and is_current`.execute(tx);
  if (versionId === null) return;
  await sql`
    insert into app.published_versions (organization_id, project_id, node_id, version_id, type_id,
        content, fields, is_current, render_policy_version)
    select v.organization_id, v.project_id, v.node_id, v.id, ${typeId}::uuid, v.content, v.fields,
           true, 1
      from app.node_versions v
     where v.organization_id = ${tenant.organizationId}::uuid
       and v.project_id = ${tenant.projectId}::uuid and v.id = ${versionId}::uuid
    on conflict on constraint published_versions_version_key do update set is_current = true`.execute(
    tx,
  );
}

// A whole publish or unpublish of one node in one transaction, as the product makes it.
export function publishChunks(
  db: Database,
  seeded: Seeded,
  nodeId: string,
  target: ChunkTarget | null,
  after?: (tx: EngineTx) => Promise<void>,
): Promise<ChunkCopy> {
  return withTenant(db, seeded.tenant, async (tx) => {
    await writeVersionRow(tx, seeded, nodeId, target?.versionId ?? null);
    const copy = await writePublishedChunks(tx, seeded.tenant, nodeId, target);
    if (after !== undefined) await after(tx);
    return copy;
  });
}

export interface TermState {
  readonly totals: readonly string[];
  readonly stats: readonly string[];
  readonly postings: readonly string[];
}

const lines = (out: string): string[] =>
  out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

const textRows = async (tx: EngineTx, query: RawBuilder<{ line: string }>) =>
  (await query.execute(tx)).rows.map((row) => row.line);

// What the three tables hold for one project, as sorted text, read as the app role under the
// tenant, as publish sees them.
export function storedTerms(db: Database, tenant: TenantRef): Promise<TermState> {
  return withTenant(db, tenant, async (tx) => ({
    totals: await textRows(
      tx,
      sql<{ line: string }>`
        select version_label || ' ' || chunk_count || ' ' || total_length as line
          from app.published_project_term_totals
         where not (chunk_count = 0 and total_length = 0) order by 1`,
    ),
    stats: await textRows(
      tx,
      sql<{ line: string }>`
        select version_label || ' ' || lexeme || ' ' || df as line
          from app.published_term_stats order by 1`,
    ),
    postings: await textRows(
      tx,
      sql<{ line: string }>`
        select version_label || ' ' || lexeme || ' ' || chunk_id || ' ' || tf || ' ' ||
               chunk_length as line
          from app.published_chunk_terms order by 1`,
    ),
  }));
}

// The same three, computed from scratch from the public current chunks. An empty project has
// no totals row worth comparing, so a zero row and no row read the same.
export function recomputedTerms(db: Database, tenant: TenantRef): Promise<TermState> {
  const live = sql`
    select c.id, u.lexeme, coalesce(cardinality(u.positions), 1) as tf
      from app.published_chunks c cross join lateral unnest(c.search) u
     where c.is_current and c.visibility = 'public'`;
  return withTenant(db, tenant, async (tx) => ({
    totals: await textRows(
      tx,
      sql<{ line: string }>`
        select 'latest ' || count(*) || ' ' || coalesce(sum(n), 0) as line
          from (select (select coalesce(sum(coalesce(cardinality(p.positions), 1)), 0)
                          from unnest(c.search) p) as n
                  from app.published_chunks c
                 where c.is_current and c.visibility = 'public') x
        having count(*) > 0`,
    ),
    stats: await textRows(
      tx,
      sql<{ line: string }>`
        select 'latest ' || lexeme || ' ' || count(*) as line from (${live}) l
         group by lexeme order by 1`,
    ),
    postings: await textRows(
      tx,
      sql<{ line: string }>`
        select 'latest ' || l.lexeme || ' ' || l.id || ' ' || l.tf || ' ' || s.n as line
          from (${live}) l
          join (select id, sum(tf) as n from (${live}) x group by id) s on s.id = l.id
         order by 1`,
    ),
  }));
}

// Every row in any term table, anywhere, that names this lexeme.
export async function lexemeRows(lexeme: string): Promise<number> {
  const out = await admin(`
select (select count(*) from app.published_term_stats where lexeme = ${text(lexeme)})
     + (select count(*) from app.published_chunk_terms where lexeme = ${text(lexeme)});`);
  return Number(out.trim());
}

export async function chunkRows(tenant: TenantRef, nodeId: string): Promise<readonly string[]> {
  return lines(
    await admin(`select version_id || ' ' || ord || ' ' || is_current || ' ' || visibility
                   from app.published_chunks
                  where organization_id = '${tenant.organizationId}'
                    and project_id = '${tenant.projectId}' and node_id = '${nodeId}'
                  order by version_id, ord;`),
  );
}

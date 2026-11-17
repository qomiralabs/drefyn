import { randomUUID } from 'node:crypto';
import {
  createDatabase,
  createPublishedDatabase,
  parseDatabaseConfig,
  parsePublishedReaderConfig,
  withTenant,
  type Database,
  type PublishedDatabase,
} from '@drefyn/db';
import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import { sql } from 'kysely';
import { inject } from 'vitest';
import {
  appTermStore,
  createRetrieval,
  createTermRebuild,
  DEFAULT_RETRIEVAL_CONFIG,
  publishedReader,
  type Retrieval,
  type RetrievalConfig,
  type RetrievalFlags,
  type RetrievalLogger,
} from '../../src/index.ts';
import { superuser, urlFor } from './stack.ts';

export const database = () => inject('retrievalDatabase');
export const admin = (text: string) => superuser(text, database());

export const openApp = (): Promise<Database> =>
  createDatabase(
    parseDatabaseConfig({
      DREFYN_DATABASE_URL: urlFor('app', database()),
      DREFYN_DATABASE_SSL: 'disable',
    }),
  );

export const openReader = (poolMax = 4): Promise<PublishedDatabase> =>
  createPublishedDatabase(
    parsePublishedReaderConfig({
      DREFYN_PUBLIC_READER_DATABASE_URL: urlFor('reader', database()),
      DREFYN_DATABASE_SSL: 'disable',
      DREFYN_DATABASE_POOL_MAX: String(poolMax),
    }),
  );

export const FLAG_ON: RetrievalFlags = { evaluate: () => Promise.resolve({ value: true }) };
export const FLAG_OFF: RetrievalFlags = { evaluate: () => Promise.resolve({ value: false }) };

export function retrievalOver(
  reader: PublishedDatabase,
  options: {
    readonly config?: Partial<RetrievalConfig>;
    readonly flags?: RetrievalFlags;
    readonly logger?: RetrievalLogger;
  } = {},
): Retrieval {
  return createRetrieval({
    reader: publishedReader(reader),
    config: { ...DEFAULT_RETRIEVAL_CONFIG, ...options.config },
    flags: options.flags ?? FLAG_ON,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
}

export interface Seeded {
  readonly tenant: TenantRef;
  readonly typeId: string;
}

const text = (value: string) => `'${value.replaceAll("'", "''")}'`;

// Organizations and projects, written as the superuser in one call. Each entry is the number
// of projects in a new organization.
export async function seedTenants(projectsPerOrganization: readonly number[]): Promise<Seeded[]> {
  const seeded: Seeded[] = [];
  const statements: string[] = [];
  for (const count of projectsPerOrganization) {
    const org = randomUUID();
    statements.push(
      `insert into app.organizations (organization_id, name, plan_tier)
         values ('${org}', 'Org', 'self_hosted');`,
    );
    for (let at = 0; at < count; at += 1) {
      const project = randomUUID();
      const typeId = randomUUID();
      statements.push(`
insert into app.projects (id, organization_id, product, slug, name)
  values ('${project}', '${org}', 'docs', 'p${project.slice(0, 8)}', 'Project');
insert into app.content_types (id, organization_id, project_id, family, key)
  values ('${typeId}', '${org}', '${project}', 'docs_page', 'page');`);
      seeded.push({
        tenant: { organizationId: organizationId(org), projectId: projectId(project) },
        typeId,
      });
    }
  }
  await admin(statements.join('\n'));
  return seeded;
}

export interface ChunkText {
  readonly heading?: readonly string[];
  readonly body: string;
}

// current: the published version a plain read gets. old: published once, since replaced.
// draft: saved and never published, so only app.chunks holds its text.
export type VersionState = 'current' | 'old' | 'draft';

export interface VersionSpec {
  readonly state: VersionState;
  readonly visibility?: 'public' | 'protected';
  readonly chunks: readonly ChunkText[];
}

export interface PageSpec {
  readonly slug: string;
  readonly title?: string;
  readonly versions: readonly VersionSpec[];
}

export interface SeededVersion {
  readonly versionId: string;
  readonly state: VersionState;
  readonly visibility: 'public' | 'protected';
  readonly chunkIds: readonly string[];
}

export interface SeededPage {
  readonly nodeId: string;
  readonly path: string;
  readonly versions: readonly SeededVersion[];
}

const textArray = (values: readonly string[]) =>
  values.length === 0 ? `'{}'::text[]` : `array[${values.map(text).join(', ')}]::text[]`;

function pageSql(seeded: Seeded, page: PageSpec): { sql: string; page: SeededPage } {
  const org = seeded.tenant.organizationId;
  const prj = seeded.tenant.projectId;
  const nodeId = randomUUID();
  const path = `/${page.slug}`;
  const title = page.title ?? page.slug;
  const rows: string[] = [
    `insert into app.nodes (id, organization_id, project_id, family, type_id, parent_id, slug,
        order_key, lifecycle)
      values ('${nodeId}', '${org}', '${prj}', 'docs_page', '${seeded.typeId}', null,
        ${text(page.slug)}, 'a${nodeId.replaceAll('-', '')}', 'draft');`,
  ];
  const versions = page.versions.map((version, at): SeededVersion => {
    const versionId = randomUUID();
    const visibility = version.visibility ?? 'public';
    const published = version.state !== 'draft';
    const chunkIds = published ? version.chunks.map(() => randomUUID()) : [];
    rows.push(
      `insert into app.node_versions (id, organization_id, project_id, node_id, seq,
          schema_version, ast_version, origin, actor, content, content_sha256, fields)
        values ('${versionId}', '${org}', '${prj}', '${nodeId}', ${String(at + 1)}, 1, 1, 'human',
          '{"kind":"system","job":"test"}', '{}', sha256('${versionId}'::bytea),
          ${text(JSON.stringify({ title }))});`,
    );
    version.chunks.forEach((chunk, ord) => {
      rows.push(
        `insert into app.chunks (organization_id, project_id, node_id, version_id, ord,
            block_path, heading_path, body, body_sha256)
          values ('${org}', '${prj}', '${nodeId}', '${versionId}', ${String(ord)}, '${String(ord)}',
            ${textArray(chunk.heading ?? [])}, ${text(chunk.body)},
            sha256(convert_to(${text(chunk.body)}, 'UTF8')));`,
      );
    });
    if (published) {
      const current = version.state === 'current';
      rows.push(
        `insert into app.published_versions (organization_id, project_id, node_id, version_id,
            type_id, content, fields, is_current, render_policy_version, visibility)
          values ('${org}', '${prj}', '${nodeId}', '${versionId}', '${seeded.typeId}', '{}',
            ${text(JSON.stringify({ title }))}, ${String(current)}, 1, '${visibility}');`,
      );
      version.chunks.forEach((chunk, ord) => {
        rows.push(
          `insert into app.published_chunks (id, organization_id, project_id, node_id, version_id,
              ord, page_path, title, heading_path, body, body_sha256, visibility, is_current)
            values ('${chunkIds[ord] ?? ''}', '${org}', '${prj}', '${nodeId}', '${versionId}',
              ${String(ord)}, ${text(path)}, ${text(title)}, ${textArray(chunk.heading ?? [])},
              ${text(chunk.body)}, sha256(convert_to(${text(chunk.body)}, 'UTF8')),
              '${visibility}', ${String(current)});`,
        );
      });
    }
    return { versionId, state: version.state, visibility, chunkIds };
  });
  return { sql: rows.join('\n'), page: { nodeId, path, versions } };
}

// Writes pages as the superuser, then builds the term tables with the library's own rebuild,
// which recomputes them from the public current chunks the same way publish keeps them.
export async function seedPages(
  app: Database,
  seeded: Seeded,
  pages: readonly PageSpec[],
): Promise<SeededPage[]> {
  const built = pages.map((page) => pageSql(seeded, page));
  if (built.length > 0) await admin(built.map((b) => b.sql).join('\n'));
  await rebuildTerms(app, seeded.tenant);
  return built.map((b) => b.page);
}

export async function rebuildTerms(app: Database, tenant: TenantRef): Promise<void> {
  const rebuilt = await createTermRebuild({ store: appTermStore(app) }).rebuildTermStats(tenant);
  if (!rebuilt.ok) throw new Error(`term rebuild failed: ${rebuilt.error}`);
}

// One page per body, all public and current, for tests that only care about ranking.
export const bodies = (prefix: string, texts: readonly string[]): PageSpec[] =>
  texts.map((body, at) => ({
    slug: `${prefix}-${String(at)}`,
    versions: [{ state: 'current', chunks: [{ body }] }],
  }));

export const chunkIdOf = (page: SeededPage | undefined): string => {
  const id = page?.versions.find((v) => v.state === 'current')?.chunkIds[0];
  if (id === undefined) throw new Error('page has no current chunk');
  return id;
};

// What the term tables hold for one project, as sorted text.
export function storedTerms(app: Database, tenant: TenantRef) {
  return withTenant(app, tenant, async (tx) => {
    const lines = async (query: ReturnType<typeof sql<{ line: string }>>) =>
      (await query.execute(tx)).rows.map((row) => row.line);
    return {
      totals: await lines(sql<{ line: string }>`
        select version_label || ' ' || chunk_count || ' ' || total_length as line
          from app.published_project_term_totals
         where not (chunk_count = 0 and total_length = 0) order by 1`),
      stats: await lines(sql<{ line: string }>`
        select version_label || ' ' || lexeme || ' ' || df as line
          from app.published_term_stats order by 1`),
      postings: await lines(sql<{ line: string }>`
        select version_label || ' ' || lexeme || ' ' || chunk_id || ' ' || tf || ' ' ||
               chunk_length as line
          from app.published_chunk_terms order by 1`),
    };
  });
}

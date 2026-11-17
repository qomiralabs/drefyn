import { randomUUID } from 'node:crypto';
import {
  closeDatabase,
  createDatabase,
  createPublishedDatabase,
  parseDatabaseConfig,
  parsePublishedReaderConfig,
  type Database,
  type PublishedDatabase,
} from '@drefyn/db';
import {
  appTermStore,
  createRetrieval,
  createTermRebuild,
  DEFAULT_RETRIEVAL_CONFIG,
  publishedReader,
  type Retrieval,
} from '@drefyn/retrieval';
import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import { afterAll, describe, inject } from 'vitest';
import { superuser, urlFor } from './stack.ts';

export function describeWithStack(name: string, body: () => void): void {
  const absent = inject('mcpStackAbsent');
  if (absent === null) describe(name, body);
  else describe.skip(`${name} [skipped, no compose stack: ${absent}]`, body);
}

export const database = () => inject('mcpDatabase');
const admin = (text: string) => superuser(text, database());

export const readerEnv = () => ({
  DREFYN_PUBLIC_READER_DATABASE_URL: urlFor('reader', database()),
  DREFYN_DATABASE_SSL: 'disable',
  DREFYN_DATABASE_POOL_MAX: '4',
});

// Both pools for one file, closed after it.
export function pools() {
  let app: Database | undefined;
  let reader: PublishedDatabase | undefined;
  afterAll(async () => {
    if (app !== undefined) await closeDatabase(app);
    if (reader !== undefined) await closeDatabase(reader);
  });
  return async () => {
    app = await createDatabase(
      parseDatabaseConfig({
        DREFYN_DATABASE_URL: urlFor('app', database()),
        DREFYN_DATABASE_SSL: 'disable',
      }),
    );
    reader = await createPublishedDatabase(parsePublishedReaderConfig(readerEnv()));
    return { app, reader };
  };
}

export const retrievalOver = (reader: PublishedDatabase, on = true): Retrieval =>
  createRetrieval({
    reader: publishedReader(reader),
    config: DEFAULT_RETRIEVAL_CONFIG,
    flags: { evaluate: () => Promise.resolve({ value: on }) },
  });

export interface Seeded {
  readonly tenant: TenantRef;
  readonly typeId: string;
}

const text = (value: string) => `'${value.replaceAll("'", "''")}'`;

// Each entry is the number of projects in a new organization. Written as the superuser, which
// bypasses RLS, as seeding two tenants needs.
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

// current: what a plain read gets. old: published once, since replaced. draft: saved and never
// published, so only app.chunks holds its text.
export type VersionState = 'current' | 'old' | 'draft';

export interface PageSpec {
  readonly slug: string;
  readonly versions: readonly {
    readonly state: VersionState;
    readonly visibility?: 'public' | 'protected';
    readonly body: string;
  }[];
}

export interface SeededPage {
  readonly nodeId: string;
  readonly path: string;
}

function pageSql(seeded: Seeded, page: PageSpec): { sql: string; page: SeededPage } {
  const org = seeded.tenant.organizationId;
  const prj = seeded.tenant.projectId;
  const nodeId = randomUUID();
  const path = `/${page.slug}`;
  const rows: string[] = [
    `insert into app.nodes (id, organization_id, project_id, family, type_id, parent_id, slug,
        order_key, lifecycle)
      values ('${nodeId}', '${org}', '${prj}', 'docs_page', '${seeded.typeId}', null,
        ${text(page.slug)}, 'a${nodeId.replaceAll('-', '')}', 'draft');`,
  ];
  page.versions.forEach((version, at) => {
    const versionId = randomUUID();
    const visibility = version.visibility ?? 'public';
    const body = text(version.body);
    rows.push(
      `insert into app.node_versions (id, organization_id, project_id, node_id, seq,
          schema_version, ast_version, origin, actor, content, content_sha256, fields)
        values ('${versionId}', '${org}', '${prj}', '${nodeId}', ${String(at + 1)}, 1, 1, 'human',
          '{"kind":"system","job":"test"}', '{}', sha256('${versionId}'::bytea),
          ${text(JSON.stringify({ title: page.slug }))});`,
      `insert into app.chunks (organization_id, project_id, node_id, version_id, ord,
          block_path, heading_path, body, body_sha256)
        values ('${org}', '${prj}', '${nodeId}', '${versionId}', 0, '0', '{}'::text[], ${body},
          sha256(convert_to(${body}, 'UTF8')));`,
    );
    if (version.state === 'draft') return;
    const current = String(version.state === 'current');
    rows.push(
      `insert into app.published_versions (organization_id, project_id, node_id, version_id,
          type_id, content, fields, is_current, render_policy_version, visibility)
        values ('${org}', '${prj}', '${nodeId}', '${versionId}', '${seeded.typeId}', '{}',
          ${text(JSON.stringify({ title: page.slug }))}, ${current}, 1, '${visibility}');`,
      `insert into app.published_chunks (organization_id, project_id, node_id, version_id, ord,
          page_path, title, heading_path, body, body_sha256, visibility, is_current)
        values ('${org}', '${prj}', '${nodeId}', '${versionId}', 0, ${text(path)},
          ${text(page.slug)}, '{}'::text[], ${body}, sha256(convert_to(${body}, 'UTF8')),
          '${visibility}', ${current});`,
    );
  });
  return { sql: rows.join('\n'), page: { nodeId, path } };
}

// Writes pages, then builds the term tables with the library's own rebuild, which keeps them
// the way publish does: public current chunks only.
export async function seedPages(
  app: Database,
  seeded: Seeded,
  pages: readonly PageSpec[],
): Promise<SeededPage[]> {
  const built = pages.map((page) => pageSql(seeded, page));
  await admin(built.map((b) => b.sql).join('\n'));
  const rebuilt = await createTermRebuild({ store: appTermStore(app) }).rebuildTermStats(
    seeded.tenant,
  );
  if (!rebuilt.ok) throw new Error(`term rebuild failed: ${rebuilt.error}`);
  return built.map((b) => b.page);
}

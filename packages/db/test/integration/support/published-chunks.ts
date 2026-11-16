import { superuser } from './stack.ts';

// Rows written as the superuser, which bypasses RLS, so the tests depend on nothing but the
// schema. In the product the only writer of these tables is publish.

const sqlText = (value: string) => `'${value.replaceAll("'", "''")}'`;
const sqlArray = (values: readonly string[]) => `array[${values.map(sqlText).join(', ')}]::text[]`;

export const uuid = (prefix: number, n: number) =>
  `01a14984-4476-77ce-9335-${String(prefix).padStart(2, '0')}${String(n).padStart(10, '0')}`;

export interface SeedTenant {
  readonly org: string;
  readonly project: string;
  readonly type: string;
  readonly node: string;
  readonly version: string;
}

export function seedTenant(prefix: number, n: number): SeedTenant {
  const base = n * 10;
  return {
    org: uuid(prefix, base + 1),
    project: uuid(prefix, base + 2),
    type: uuid(prefix, base + 3),
    node: uuid(prefix, base + 4),
    version: uuid(prefix, base + 5),
  };
}

// One organization, project, type, node, saved version and its published copy per tenant.
// Tenants that share an organization id get it once.
export function seedTenantsSql(tenants: readonly SeedTenant[]): string {
  const orgs = [...new Set(tenants.map((t) => t.org))];
  return [
    `insert into app.organizations (organization_id, name, plan_tier) values
       ${orgs.map((org) => `('${org}', 'org', 'self_hosted')`).join(', ')};`,
    ...tenants.map(
      (t) => `
insert into app.projects (id, organization_id, product, slug, name)
  values ('${t.project}', '${t.org}', 'docs', 'p${t.project.slice(-6)}', 'P');
insert into app.content_types (id, organization_id, project_id, family, key)
  values ('${t.type}', '${t.org}', '${t.project}', 'docs_page', 'page');
insert into app.nodes (id, organization_id, project_id, family, type_id, order_key, lifecycle)
  values ('${t.node}', '${t.org}', '${t.project}', 'docs_page', '${t.type}', 'a0', 'published');
insert into app.node_versions (id, organization_id, project_id, node_id, seq, schema_version,
    ast_version, origin, actor, content, content_sha256)
  values ('${t.version}', '${t.org}', '${t.project}', '${t.node}', 1, 1, 1, 'human',
    '{"kind":"system","job":"test"}', '{}', sha256('${t.version}'::bytea));
${publishedVersionSql(t)}`,
    ),
  ].join('\n');
}

// The published chunks migration runs after the visibility one, so the column is always there.
export function publishedVersionSql(t: SeedTenant): string {
  return `
insert into app.published_versions (organization_id, project_id, node_id, version_id, type_id,
    content, is_current, render_policy_version, visibility)
  values ('${t.org}', '${t.project}', '${t.node}', '${t.version}', '${t.type}', '{}', true, 1,
    'public');`;
}

export interface ChunkSeed {
  readonly ord: number;
  readonly headingPath: readonly string[];
  readonly body: string;
  readonly visibility: 'public' | 'protected';
  readonly current?: boolean;
  readonly path?: string;
  readonly title?: string;
}

export function chunkSql(t: SeedTenant, chunk: ChunkSeed): string {
  return `
insert into app.published_chunks (organization_id, project_id, node_id, version_id, ord,
    page_path, title, heading_path, body, body_sha256, visibility, is_current)
  values ('${t.org}', '${t.project}', '${t.node}', '${t.version}', ${String(chunk.ord)},
    ${sqlText(chunk.path ?? '/page')}, ${sqlText(chunk.title ?? 'Page')},
    ${sqlArray(chunk.headingPath)}, ${sqlText(chunk.body)}, sha256(convert_to(${sqlText(chunk.body)}, 'UTF8')),
    '${chunk.visibility}', ${String(chunk.current ?? true)});`;
}

export async function seed(database: string, statements: string): Promise<void> {
  await superuser(statements, database);
}

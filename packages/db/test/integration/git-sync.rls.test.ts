import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import { sql } from 'kysely';
import { beforeAll, expect, it } from 'vitest';
import { DbError, withTenant, type Database } from '../../src/index.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { superuser } from './support/stack.ts';
import { failure, pools } from './support/tenancy.ts';

const dbs = databases();
const openPools = pools();

const id = (n: number) => `01a14984-4476-77ce-9335-63${String(n).padStart(10, '0')}`;

interface Tenant {
  readonly org: string;
  readonly project: string;
  readonly type: string;
  readonly node: string;
  readonly version: string;
  readonly binding: string;
  readonly changeSet: string;
  // A node with no file yet, so a test can map it.
  readonly spareNode: string;
  readonly spareVersion: string;
}

const tenant = (org: number, project: number, base: number): Tenant => ({
  org: id(org),
  project: id(project),
  type: id(base + 1),
  node: id(base + 2),
  version: id(base + 3),
  binding: id(base + 4),
  changeSet: id(base + 5),
  spareNode: id(base + 6),
  spareVersion: id(base + 7),
});

const A = tenant(1, 11, 100);
// Same organization as A, another project.
const A2 = tenant(1, 12, 200);
const B = tenant(2, 21, 300);
const ALL = [A, A2, B];
const SHA = 'b'.repeat(40);

const rows = (t: Tenant) => `
insert into app.content_types (id, organization_id, project_id, family, key)
  values ('${t.type}', '${t.org}', '${t.project}', 'docs_page', 'page');
insert into app.nodes (id, organization_id, project_id, family, type_id, order_key, lifecycle)
  values ('${t.node}', '${t.org}', '${t.project}', 'docs_page', '${t.type}', 'a0', 'draft'),
         ('${t.spareNode}', '${t.org}', '${t.project}', 'docs_page', '${t.type}', 'a1', 'draft');
insert into app.node_versions (id, organization_id, project_id, node_id, seq, schema_version,
    ast_version, origin, actor, content, content_sha256, idempotency_key)
  values ('${t.version}', '${t.org}', '${t.project}', '${t.node}', 1, 1, 1, 'human', '{}', '{}',
          decode(repeat('aa', 32), 'hex'), 'first-save'),
         ('${t.spareVersion}', '${t.org}', '${t.project}', '${t.spareNode}', 1, 1, 1, 'human',
          '{}', '{}', decode(repeat('aa', 32), 'hex'), 'spare-save');
insert into app.git_bindings (id, organization_id, project_id, installation_id, repository_id,
    owner, name, branch, folder)
  values ('${t.binding}', '${t.org}', '${t.project}', 1, 2, 'acme', 'docs', 'main', 'docs');
insert into app.git_files (organization_id, project_id, binding_id, path, node_id, blob_sha,
    synced_version_id)
  values ('${t.org}', '${t.project}', '${t.binding}', 'docs/a.mdx', '${t.node}', '${SHA}',
          '${t.version}');
insert into app.git_deliveries (organization_id, project_id, binding_id, delivery_id, head_sha)
  values ('${t.org}', '${t.project}', '${t.binding}', 'same-delivery', '${SHA}');
insert into app.git_outbound (organization_id, project_id, change_set_id, binding_id)
  values ('${t.org}', '${t.project}', '${t.changeSet}', '${t.binding}');`;

const seedSql = `
insert into app.organizations (organization_id, name, plan_tier)
  values ('${A.org}', 'A', 'self_hosted'), ('${B.org}', 'B', 'self_hosted');
insert into app.projects (id, organization_id, product, slug, name)
  values ('${A.project}', '${A.org}', 'docs', 'one', 'One'),
         ('${A2.project}', '${A2.org}', 'docs', 'two', 'Two'),
         ('${B.project}', '${B.org}', 'docs', 'one', 'One');
${ALL.map(rows).join('\n')}`;

const ref = (t: Tenant): TenantRef => ({
  organizationId: organizationId(t.org),
  projectId: projectId(t.project),
});

const TABLES = ['git_bindings', 'git_files', 'git_deliveries', 'git_outbound'] as const;

let db: TestDatabase;
let pool: Database;

beforeAll(async () => {
  db = await dbs.fresh('migrated');
  await superuser(seedSql, db.name);
  pool = await openPools.app(db.app);
});

// Tenant ids of every row a tenant can see in one table.
const visible = (as: Tenant, table: (typeof TABLES)[number]) =>
  withTenant(pool, ref(as), async (tx) => {
    const result = await sql<{ owner: string }>`
      select organization_id || '/' || project_id as owner from ${sql.table(`app.${table}`)}`.execute(
      tx,
    );
    return result.rows.map((row) => row.owner);
  });

const attempt = (as: Tenant, statement: ReturnType<typeof sql>) =>
  withTenant(pool, ref(as), async (tx) => {
    const result = await statement.execute(tx);
    return Number(result.numAffectedRows ?? 0n);
  }).then(
    (affected) => ({ affected, code: undefined }),
    (error: unknown) => ({
      affected: 0,
      code: error instanceof DbError ? error.code : (failure(error).code ?? String(error)),
    }),
  );

describeWithStack('git sync tables between tenants', () => {
  it.each(TABLES)('%s shows each tenant only its own row', async (table) => {
    for (const t of ALL) {
      expect(await visible(t, table)).toEqual([`${t.org}/${t.project}`]);
    }
  });

  it.each(TABLES)('%s updates and deletes nothing of another tenant', async (table) => {
    const target = sql.table(`app.${table}`);
    for (const [as, other] of [
      [A, B],
      [A, A2],
    ] as const) {
      const update = await attempt(
        as,
        sql`update ${target} set organization_id = organization_id
             where organization_id = ${other.org} and project_id = ${other.project}`,
      );
      expect(update).toEqual({ affected: 0, code: undefined });
      const remove = await attempt(
        as,
        sql`delete from ${target}
             where organization_id = ${other.org} and project_id = ${other.project}`,
      );
      expect(remove).toEqual({ affected: 0, code: undefined });
    }
    expect(await visible(B, table)).toEqual([`${B.org}/${B.project}`]);
  });

  it('refuses a delivery written for another project or organization', async () => {
    for (const as of [A2, B]) {
      const refused = await attempt(
        as,
        sql`insert into app.git_deliveries
              (organization_id, project_id, binding_id, delivery_id, head_sha)
            values (${A.org}, ${A.project}, ${A.binding}, 'stolen', ${SHA})`,
      );
      expect(refused.code).toBe('DB_RLS_VIOLATION');
    }
  });

  it('refuses a binding written for another project', async () => {
    const refused = await attempt(
      A2,
      sql`insert into app.git_bindings
            (organization_id, project_id, installation_id, repository_id, owner, name, branch,
             folder)
          values (${A.org}, ${A.project}, 1, 2, 'acme', 'docs', 'main', '')`,
    );
    expect(refused.code).toBe('DB_RLS_VIOLATION');
  });

  it('refuses a file or outbound row pointing at another tenant binding', async () => {
    const file = await attempt(
      B,
      sql`insert into app.git_files
            (organization_id, project_id, binding_id, path, node_id, blob_sha, synced_version_id)
          values (${B.org}, ${B.project}, ${A.binding}, 'docs/x.mdx', ${B.spareNode}, ${SHA},
                  ${B.spareVersion})`,
    );
    // The binding key includes the tenant ids, so another tenant's binding is no parent at all.
    expect(file.code).toBe('23503');
    const outbound = await attempt(
      B,
      sql`insert into app.git_outbound (organization_id, project_id, change_set_id, binding_id)
          values (${B.org}, ${B.project}, ${id(999)}, ${A.binding})`,
    );
    expect(outbound.code).toBe('23503');
  });
});

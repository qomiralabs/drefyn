import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createProtectedReaderDatabase,
  createPublishedDatabase,
  withProtectedReader,
  withPublishedReader,
  type ProtectedReaderDatabase,
  type PublishedDatabase,
} from '../../src/index.ts';
import { PUBLISHED_TABLES } from '../../src/allow-lists.ts';
import type { DbError } from '../../src/errors.ts';
import { rejected } from '../support.ts';
import { describeFailure, migrate, shippedMigrations } from './support/cli.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { superuser } from './support/stack.ts';
import {
  failure,
  pools,
  protectedConfig,
  protectedUrl,
  rawSession,
  readerConfig,
  rows,
} from './support/tenancy.ts';

const dbs = databases();
const open = pools();

const id = (n: number) => `01a14984-4476-77ce-9335-38${String(n).padStart(10, '0')}`;

interface Tenant {
  readonly ref: TenantRef;
  readonly type: string;
  readonly publicNode: string;
  readonly protectedNode: string;
  readonly publicVersion: string;
  readonly protectedVersion: string;
}

function tenant(org: number, project: number, base: number): Tenant {
  return {
    ref: { organizationId: organizationId(id(org)), projectId: projectId(id(project)) },
    type: id(base + 1),
    publicNode: id(base + 2),
    protectedNode: id(base + 3),
    publicVersion: id(base + 4),
    protectedVersion: id(base + 5),
  };
}

const A = tenant(1, 11, 100);
const B = tenant(2, 21, 200);
const TENANTS = [A, B];

const TABLES = ['published_versions', 'published_filter_rows'] as const;
type Table = (typeof TABLES)[number];

const hashSql = (byte: string) => `decode(repeat('${byte}', 32), 'hex')`;

// Draft rows the published copies point at, then one public and one protected copy per tenant
// in each published table. Without visibility, the rows are written the way the tables took
// them before the column existed.
const seedSql = (t: Tenant, visible = true) => {
  const org = t.ref.organizationId;
  const prj = t.ref.projectId;
  const column = visible ? ', visibility' : '';
  const value = (v: string) => (visible ? `, '${v}'` : '');
  return `
insert into app.content_types (id, organization_id, project_id, family, key)
  values ('${t.type}', '${org}', '${prj}', 'docs_page', 'page');
insert into app.nodes (id, organization_id, project_id, family, type_id, order_key, lifecycle)
  values ('${t.publicNode}', '${org}', '${prj}', 'docs_page', '${t.type}', 'a0', 'published'),
         ('${t.protectedNode}', '${org}', '${prj}', 'docs_page', '${t.type}', 'a1', 'published');
insert into app.node_versions (id, organization_id, project_id, node_id, seq, schema_version,
    ast_version, origin, actor, content, content_sha256)
  values ('${t.publicVersion}', '${org}', '${prj}', '${t.publicNode}', 1, 1, 1, 'human', '{}',
          '{}', ${hashSql('a1')}),
         ('${t.protectedVersion}', '${org}', '${prj}', '${t.protectedNode}', 1, 1, 1, 'human',
          '{}', '{}', ${hashSql('b2')});
insert into app.published_versions (organization_id, project_id, node_id, version_id, type_id,
    content, is_current, render_policy_version${column})
  values ('${org}', '${prj}', '${t.publicNode}', '${t.publicVersion}', '${t.type}', '{}', true, 1
          ${value('public')}),
         ('${org}', '${prj}', '${t.protectedNode}', '${t.protectedVersion}', '${t.type}', '{}',
          true, 1${value('protected')});
insert into app.published_filter_rows (organization_id, project_id, type_id, node_id${column})
  values ('${org}', '${prj}', '${t.type}', '${t.publicNode}'${value('public')}),
         ('${org}', '${prj}', '${t.type}', '${t.protectedNode}'${value('protected')});`;
};

const seedAll = (visible = true) => `
insert into app.organizations (organization_id, name, plan_tier)
  values ('${A.ref.organizationId}', 'A', 'self_hosted'), ('${B.ref.organizationId}', 'B', 'self_hosted');
insert into app.projects (id, organization_id, product, slug, name)
  values ('${A.ref.projectId}', '${A.ref.organizationId}', 'docs', 'one', 'One'),
         ('${B.ref.projectId}', '${B.ref.organizationId}', 'docs', 'one', 'One');
${TENANTS.map((t) => seedSql(t, visible)).join('\n')}`;

const nodesIn = (table: Table) =>
  sql<{ node_id: string; visibility: string }>`
    select node_id::text, visibility from ${sql.table(`app.${table}`)} order by node_id`;

let db: TestDatabase;
let reader: PublishedDatabase;
let protectedReader: ProtectedReaderDatabase;

describeWithStack('published visibility on the shipped tables', () => {
  beforeAll(async () => {
    db = await dbs.fresh('migrated');
    await superuser(seedAll(), db.name);
    reader = await open.reader(db.reader);
    protectedReader = await open.protectedReader(protectedUrl(db));
  });

  describe.each(TABLES)('app.%s', (table) => {
    it('gives the public reader 0 protected rows and its public row', async () => {
      for (const t of TENANTS) {
        const seen = await withPublishedReader(reader, t.ref, (tx) => rows(tx, nodesIn(table)));
        expect(seen).toEqual([{ node_id: t.publicNode, visibility: 'public' }]);
      }
    });

    // The guard holds even when the query asks for protected rows by name.
    it('gives the public reader 0 protected rows when it asks for them', async () => {
      const seen = await withPublishedReader(reader, A.ref, (tx) =>
        rows(
          tx,
          sql<{ n: number }>`select count(*)::int as n from ${sql.table(`app.${table}`)}
            where visibility = 'protected' or node_id = ${A.protectedNode}`,
        ),
      );
      expect(seen).toEqual([{ n: 0 }]);
    });

    it('gives the protected reader both rows of its own tenant and none of another', async () => {
      for (const t of TENANTS) {
        const seen = await withProtectedReader(protectedReader, { tenant: t.ref }, (tx) =>
          rows(tx, nodesIn(table)),
        );
        expect(seen).toEqual(
          [
            { node_id: t.publicNode, visibility: 'public' },
            { node_id: t.protectedNode, visibility: 'protected' },
          ].sort((x, y) => x.node_id.localeCompare(y.node_id)),
        );
      }
    });

    it('gives the protected reader nothing without a tenant', async () => {
      const client = await rawSession('protected', db.name);
      try {
        const result = await client.query(`select count(*)::int as n from app.${table}`);
        expect(result.rows).toEqual([{ n: 0 }]);
      } finally {
        await client.end();
      }
    });

    it.each([
      ['insert', `insert into app.${table} select * from app.${table} limit 1`],
      ['update', `update app.${table} set visibility = 'public'`],
      ['delete', `delete from app.${table}`],
      ['truncate', `truncate app.${table}`],
    ])('refuses the protected reader a %s', async (_label, statement) => {
      const client = await rawSession('protected', db.name);
      try {
        expect(failure(await rejected(client.query(statement))).code).toBe('42501');
      } finally {
        await client.end();
      }
    });

    it('refuses a row without visibility, or with a value it does not know', async () => {
      const columns =
        table === 'published_versions'
          ? `organization_id, project_id, node_id, version_id, type_id, content, is_current,
             render_policy_version`
          : 'organization_id, project_id, type_id, node_id';
      const values =
        table === 'published_versions'
          ? `'${A.ref.organizationId}', '${A.ref.projectId}', '${A.publicNode}',
             '${A.publicVersion}', '${A.type}', '{}', false, 1`
          : `'${A.ref.organizationId}', '${A.ref.projectId}', '${A.type}', '${A.publicNode}'`;
      await expect(
        superuser(`insert into app.${table} (${columns}) values (${values});`, db.name),
      ).rejects.toThrow(/null value in column "visibility".*violates not-null constraint/);
      await expect(
        superuser(
          `insert into app.${table} (${columns}, visibility) values (${values}, 'private');`,
          db.name,
        ),
      ).rejects.toThrow(`violates check constraint "${table}_visibility_check"`);
    });
  });

  it.each(['nodes', 'node_versions', 'node_filter_rows', 'content_types', 'projects'])(
    'refuses the protected reader any read of app.%s',
    async (table) => {
      const client = await rawSession('protected', db.name);
      try {
        await client.query('begin');
        await client.query("select set_config('drefyn.organization_id', $1, true)", [
          A.ref.organizationId,
        ]);
        await client.query("select set_config('drefyn.project_id', $1, true)", [A.ref.projectId]);
        const error = failure(await rejected(client.query(`select * from app.${table}`)));
        expect(error.code).toBe('42501');
        expect(error.message).toMatch(/permission denied/);
      } finally {
        await client.end();
      }
    },
  );

  it('keeps nodes.visibility_override to null, public or protected', async () => {
    await superuser(
      `update app.nodes set visibility_override = 'protected' where id = '${A.protectedNode}';
       update app.nodes set visibility_override = 'public' where id = '${A.publicNode}';
       update app.nodes set visibility_override = null where id = '${A.publicNode}';`,
      db.name,
    );
    await expect(
      superuser(
        `update app.nodes set visibility_override = 'private' where id = '${A.publicNode}';`,
        db.name,
      ),
    ).rejects.toThrow(/nodes_visibility_override_check/);
  });

  // A URL pasted into the wrong key must fail at startup, not serve empty or protected pages.
  it('opens the protected pool only as drefyn_protected_reader', async () => {
    const asPublic = await rejected(createProtectedReaderDatabase(protectedConfig(db.reader)));
    expect((asPublic as DbError).code).toBe('DB_ROLE_UNSAFE');
    expect(String(asPublic)).toContain('drefyn_protected_reader');
    const asApp = await rejected(createProtectedReaderDatabase(protectedConfig(db.app)));
    expect((asApp as DbError).code).toBe('DB_ROLE_UNSAFE');
    const publicOnProtected = await rejected(
      createPublishedDatabase(readerConfig(protectedUrl(db))),
    );
    expect((publicOnProtected as DbError).code).toBe('DB_ROLE_UNSAFE');
  });

  it('runs protected reads read only', async () => {
    const error = await rejected(
      withProtectedReader(protectedReader, { tenant: A.ref }, (tx) =>
        sql`create temporary table sneaky (id int)`.execute(tx),
      ),
    );
    expect(failure(error).code).toBe('25006');
  });
});

describeWithStack('the drefyn_protected_reader role from the bootstrap', () => {
  it('has the attributes of the other pool roles, CONNECT on drefyn and nothing else', async () => {
    const row = await superuser(
      `select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit,
              rolreplication, rolconfig is null,
              (select count(*) from pg_db_role_setting s where s.setrole = r.oid),
              (select count(*) from pg_auth_members m where m.member = r.oid or m.roleid = r.oid),
              has_database_privilege(r.oid, 'drefyn', 'CONNECT'),
              has_database_privilege(r.oid, 'drefyn', 'TEMP'),
              has_database_privilege(r.oid, 'postgres', 'CONNECT')
         from pg_roles r where rolname = 'drefyn_protected_reader';`,
    );
    expect(row.trim()).toBe('t|f|f|f|f|f|f|t|0|0|t|f|f');
  });
});

const grantsTo = (db: TestDatabase, role: string) =>
  superuser(
    `select coalesce(string_agg(table_name || ' ' || privilege_type, ',' order by table_name,
       privilege_type), '')
     from information_schema.role_table_grants
     where grantee = '${role}' and table_schema = 'app';`,
    db.name,
  ).then((text) => text.trim());

const visibilityState = (db: TestDatabase) =>
  superuser(
    `select coalesce(string_agg(c.relname || '.' || a.attname, ','
         order by c.relname || '.' || a.attname), 'none')
       from pg_attribute a join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'app' and c.relkind = 'r'
        and a.attname in ('visibility', 'visibility_override')
        and not a.attisdropped;
     select coalesce(string_agg(tablename || ' ' || policyname, ','
         order by tablename || ' ' || policyname), 'none')
       from pg_policies where schemaname = 'app'
        and policyname in ('published_public_only', 'protected_read');`,
    db.name,
  ).then((text) => text.trim().split('\n'));

// Every table on the published allow list, without the schema. Later migrations add published
// tables, and each must carry the same guard, so the expectations follow the list.
const PUBLISHED = PUBLISHED_TABLES.map((entry) => entry.name.replace(/^app\./, '')).sort();
const listOf = (text: string) => text.split(',').sort();

describeWithStack('the published visibility migration', () => {
  const step = async (target: TestDatabase, args: readonly string[]) => {
    const result = await migrate(args, { url: target.owner });
    expect(result.code, describeFailure(result)).toBe(0);
  };

  it('grants the protected reader select on the published tables and nothing else', async () => {
    const fresh = await dbs.fresh('migrated');
    expect(listOf(await grantsTo(fresh, 'drefyn_protected_reader'))).toEqual(
      PUBLISHED.map((t) => `${t} SELECT`),
    );
  });

  it('reverts cleanly, starts rows published before it as public, and applies again', async () => {
    const fresh = await dbs.fresh('migrated');
    const shipped = shippedMigrations();
    const at = shipped.findIndex((f) => f.endsWith('_published_visibility.sql'));
    expect(at).toBeGreaterThanOrEqual(0);
    const back = shipped.length - at;
    await step(fresh, ['migrate', 'down', String(back)]);
    expect(await visibilityState(fresh)).toEqual(['none', 'none']);
    expect(await grantsTo(fresh, 'drefyn_protected_reader')).toBe('');

    // Rows from before the column, written the way the tables allowed then.
    await superuser(seedAll(false), fresh.name);
    await step(fresh, ['migrate', 'up']);
    const [columns = '', guards = ''] = await visibilityState(fresh);
    expect(listOf(columns)).toEqual(
      ['nodes.visibility_override', ...PUBLISHED.map((t) => `${t}.visibility`)].sort(),
    );
    expect(listOf(guards)).toEqual(
      PUBLISHED.flatMap((t) => [`${t} protected_read`, `${t} published_public_only`]).sort(),
    );
    const kept = await superuser(
      `select string_agg(distinct visibility, ',') from app.published_versions;
       select string_agg(distinct visibility, ',') from app.published_filter_rows;`,
      fresh.name,
    );
    expect(kept.trim().split('\n')).toEqual(['public', 'public']);
    expect(listOf(await grantsTo(fresh, 'drefyn_protected_reader'))).toEqual(
      PUBLISHED.map((t) => `${t} SELECT`),
    );
  });
});

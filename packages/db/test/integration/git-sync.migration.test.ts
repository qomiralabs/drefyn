import { expect, it } from 'vitest';
import { describeFailure, migrate, shippedMigrations } from './support/cli.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { superuser } from './support/stack.ts';

const dbs = databases();

const TABLES = ['git_bindings', 'git_deliveries', 'git_files', 'git_outbound'];
const NAMES = TABLES.map((t) => `'${t}'`).join(', ');

const id = (n: number) => `01a14984-4476-77ce-9335-62${String(n).padStart(10, '0')}`;
const ORG = id(1);
const PROJECT = id(2);
const TYPE = id(3);
const NODE = id(4);
const VERSION = id(5);
const BINDING = id(6);
const SHA = 'a'.repeat(40);

const seedSql = `
insert into app.organizations (organization_id, name, plan_tier)
  values ('${ORG}', 'A', 'self_hosted');
insert into app.projects (id, organization_id, product, slug, name)
  values ('${PROJECT}', '${ORG}', 'docs', 'one', 'One');
insert into app.content_types (id, organization_id, project_id, family, key)
  values ('${TYPE}', '${ORG}', '${PROJECT}', 'docs_page', 'page');
insert into app.nodes (id, organization_id, project_id, family, type_id, order_key, lifecycle)
  values ('${NODE}', '${ORG}', '${PROJECT}', 'docs_page', '${TYPE}', 'a0', 'draft');
insert into app.node_versions (id, organization_id, project_id, node_id, seq, schema_version,
    ast_version, origin, actor, content, content_sha256, idempotency_key)
  values ('${VERSION}', '${ORG}', '${PROJECT}', '${NODE}', 1, 1, 1, 'human', '{}', '{}',
          decode(repeat('aa', 32), 'hex'), 'first-save');
insert into app.git_bindings (id, organization_id, project_id, installation_id, repository_id,
    owner, name, branch, folder)
  values ('${BINDING}', '${ORG}', '${PROJECT}', 1, 2, 'acme', 'docs', 'main', 'docs');`;

const step = async (db: TestDatabase, args: readonly string[]) => {
  const result = await migrate(args, { url: db.owner });
  expect(result.code, describeFailure(result)).toBe(0);
};

function stepsBack(): number {
  const shipped = shippedMigrations();
  const at = shipped.findIndex((file) => file.endsWith('_git_sync.sql'));
  expect(at).toBeGreaterThanOrEqual(0);
  return shipped.length - at;
}

// The error text of a statement the superuser runs, or '' when it went through. The superuser
// skips row level security, so only the table's own constraints can refuse it.
const refusal = (db: TestDatabase, text: string) =>
  superuser(text, db.name).then(
    () => '',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

const seeded = async () => {
  const db = await dbs.fresh('migrated');
  await superuser(seedSql, db.name);
  return db;
};

const insertBinding = (folder: string, project = PROJECT) =>
  `insert into app.git_bindings (organization_id, project_id, installation_id, repository_id,
     owner, name, branch, folder)
   values ('${ORG}', '${project}', 1, 2, 'acme', 'docs', 'main', '${folder}');`;

const insertDelivery = (delivery: string, head: string | null = SHA) =>
  `insert into app.git_deliveries (organization_id, project_id, binding_id, delivery_id, head_sha)
   values ('${ORG}', '${PROJECT}', '${BINDING}', '${delivery}',
           ${head === null ? 'null' : `'${head}'`});`;

describeWithStack('the git sync migration', () => {
  it('forces row level security with only the project policy on every table', async () => {
    const db = await dbs.fresh('migrated');
    const forced = await superuser(
      `select count(*) from pg_class where relnamespace = 'app'::regnamespace
         and relname in (${NAMES}) and relrowsecurity and relforcerowsecurity;`,
      db.name,
    );
    expect(forced.trim()).toBe('4');
    const policies = await superuser(
      `select string_agg(tablename || ' ' || policyname || ' ' || cmd || ' ' ||
         array_to_string(roles, '+'), ',' order by tablename)
       from pg_policies where schemaname = 'app' and tablename in (${NAMES});`,
      db.name,
    );
    expect(policies.trim()).toBe(
      TABLES.map((t) => `${t} tenant_isolation ALL drefyn_app`).join(','),
    );
    const reader = await superuser(
      `select count(*) from information_schema.role_table_grants
        where grantee = 'drefyn_public_reader' and table_name in (${NAMES});`,
      db.name,
    );
    expect(reader.trim()).toBe('0');
  });

  it('has every key, index and statistic in scope', async () => {
    const db = await dbs.fresh('migrated');
    const constraints = await superuser(
      `select conrelid::regclass::text || ' ' || conname from pg_constraint
        where conrelid in (select oid from pg_class where relnamespace = 'app'::regnamespace
                             and relname in (${NAMES}))
          and contype in ('p', 'u', 'f') order by 1;`,
      db.name,
    );
    expect(constraints.trim().split('\n')).toEqual([
      'git_bindings git_bindings_pkey',
      'git_bindings git_bindings_project_fkey',
      'git_bindings git_bindings_project_key',
      'git_bindings git_bindings_tenant_id_key',
      'git_deliveries git_deliveries_binding_fkey',
      'git_deliveries git_deliveries_delivery_key',
      'git_deliveries git_deliveries_pkey',
      'git_files git_files_binding_fkey',
      'git_files git_files_node_key',
      'git_files git_files_pkey',
      'git_files git_files_version_fkey',
      'git_outbound git_outbound_binding_fkey',
      'git_outbound git_outbound_change_set_key',
      'git_outbound git_outbound_pkey',
    ]);
    const keys = await superuser(
      `select conname || ' ' || pg_get_constraintdef(oid) from pg_constraint
        where conname in ('git_files_pkey', 'git_deliveries_delivery_key',
                          'git_outbound_change_set_key', 'git_bindings_project_key',
                          'git_files_node_key')
        order by 1;`,
      db.name,
    );
    expect(keys.trim().split('\n')).toEqual([
      'git_bindings_project_key UNIQUE (organization_id, project_id)',
      'git_deliveries_delivery_key UNIQUE (organization_id, project_id, delivery_id)',
      'git_files_node_key UNIQUE (organization_id, project_id, node_id)',
      'git_files_pkey PRIMARY KEY (organization_id, project_id, binding_id, path)',
      'git_outbound_change_set_key UNIQUE (organization_id, project_id, change_set_id)',
    ]);
    const queued = await superuser(
      `select indexdef from pg_indexes where indexname = 'git_deliveries_queued';`,
      db.name,
    );
    expect(queued.trim()).toContain(
      '(organization_id, project_id, binding_id, received_at DESC, id DESC) WHERE (state = ',
    );
    const stats = await superuser(
      `select stxname from pg_statistic_ext where stxname like 'git_%' order by 1;`,
      db.name,
    );
    expect(stats.trim()).toBe('git_bindings_tenant_stats');
  });

  it('accepts a safe folder and the repository root', async () => {
    const db = await seeded();
    const other = id(20);
    await superuser(
      `insert into app.projects (id, organization_id, product, slug, name)
         values ('${other}', '${ORG}', 'docs', 'two', 'Two');`,
      db.name,
    );
    expect(await refusal(db, insertBinding('', other))).toBe('');
  });

  it.each(['/docs', 'docs/', 'a//b', '..', '../x', 'a/../b', '.', 'a/./b', 'a/..'])(
    'refuses the folder %j',
    async (folder) => {
      const db = await seeded();
      const other = id(21);
      await superuser(
        `insert into app.projects (id, organization_id, product, slug, name)
           values ('${other}', '${ORG}', 'docs', 'three', 'Three');`,
        db.name,
      );
      expect(await refusal(db, insertBinding(folder, other))).toContain(
        'git_bindings_folder_check',
      );
    },
  );

  it('keeps one binding per project', async () => {
    const db = await seeded();
    expect(await refusal(db, insertBinding('other'))).toContain('git_bindings_project_key');
  });

  it('refuses unknown states and malformed hashes', async () => {
    const db = await seeded();
    expect(
      await refusal(db, `update app.git_bindings set state = 'gone' where id = '${BINDING}';`),
    ).toContain('git_bindings_state_check');
    expect(
      await refusal(
        db,
        `update app.git_bindings set last_synced_commit = 'abc' where id = '${BINDING}';`,
      ),
    ).toContain('git_bindings_last_synced_commit_check');
    expect(await refusal(db, insertDelivery('d1', 'XYZ'))).toContain(
      'git_deliveries_head_sha_check',
    );
    expect(await refusal(db, insertDelivery('has space'))).toContain(
      'git_deliveries_delivery_id_check',
    );
  });

  it('stores a delivery id once per tenant and allows a reconcile with no head', async () => {
    const db = await seeded();
    expect(await refusal(db, insertDelivery('d1'))).toBe('');
    expect(await refusal(db, insertDelivery('d1'))).toContain('git_deliveries_delivery_key');
    expect(await refusal(db, insertDelivery('reconcile:1', null))).toBe('');
  });

  it('maps a node to one path and refuses a version of another node', async () => {
    const db = await seeded();
    const file = (path: string, version = VERSION) =>
      `insert into app.git_files (organization_id, project_id, binding_id, path, node_id, blob_sha,
         synced_version_id)
       values ('${ORG}', '${PROJECT}', '${BINDING}', '${path}', '${NODE}', '${SHA}', '${version}');`;
    expect(await refusal(db, file('docs/a.mdx'))).toBe('');
    expect(await refusal(db, file('docs/b.mdx'))).toContain('git_files_node_key');
    await superuser(`delete from app.git_files;`, db.name);
    expect(await refusal(db, file('docs/a.mdx', id(99)))).toContain('git_files_version_fkey');
  });

  it('keeps one outbound row per change set and a sha on every committed one', async () => {
    const db = await seeded();
    const out = (changeSet: string, state: string, sha: string | null) =>
      `insert into app.git_outbound (organization_id, project_id, change_set_id, binding_id, state,
         commit_sha)
       values ('${ORG}', '${PROJECT}', '${changeSet}', '${BINDING}', '${state}',
               ${sha === null ? 'null' : `'${sha}'`});`;
    expect(await refusal(db, out(id(30), 'queued', null))).toBe('');
    expect(await refusal(db, out(id(30), 'queued', null))).toContain('git_outbound_change_set_key');
    expect(await refusal(db, out(id(31), 'committed', null))).toContain(
      'git_outbound_committed_sha',
    );
    expect(await refusal(db, out(id(32), 'pushed', null))).toContain('git_outbound_state_check');
  });

  it('reverts cleanly and applies again', async () => {
    const db = await dbs.fresh('migrated');
    await step(db, ['migrate', 'down', String(stepsBack())]);
    const left = await superuser(
      `select count(*) from pg_class where relnamespace = 'app'::regnamespace
         and relname like 'git\\_%';`,
      db.name,
    );
    expect(left.trim()).toBe('0');
    await step(db, ['migrate', 'up']);
    const back = await superuser(
      `select count(*) from pg_tables where schemaname = 'app' and tablename in (${NAMES});`,
      db.name,
    );
    expect(back.trim()).toBe('4');
  });
});

import { expect, it } from 'vitest';
import { describeFailure, migrate, shippedMigrations } from './support/cli.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { superuser } from './support/stack.ts';

const dbs = databases();

const NAMES = `'github_installations', 'github_webhook_deliveries'`;

const id = (n: number) => `01a14984-4476-77ce-9335-63${String(n).padStart(10, '0')}`;
const ORG = id(1);
const PROJECT = id(2);

const seedSql = `
insert into app.organizations (organization_id, name, plan_tier)
  values ('${ORG}', 'A', 'self_hosted');
insert into app.projects (id, organization_id, product, slug, name)
  values ('${PROJECT}', '${ORG}', 'docs', 'one', 'One');`;

const step = async (db: TestDatabase, args: readonly string[]) => {
  const result = await migrate(args, { url: db.owner });
  expect(result.code, describeFailure(result)).toBe(0);
};

function stepsBack(): number {
  const shipped = shippedMigrations();
  const at = shipped.findIndex((file) => file.endsWith('_github.sql'));
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

const installation = (installationId: string, repositories: string, project = PROJECT) =>
  `insert into app.github_installations
     (organization_id, project_id, installation_id, account_id, repository_ids)
   values ('${ORG}', '${project}', ${installationId}, 9, ${repositories});`;

const delivery = (deliveryId: string, digest: string, event = 'push') =>
  `insert into app.github_webhook_deliveries (delivery_id, body_sha256, event)
   values ('${deliveryId}', ${digest}, '${event}');`;

const DIGEST = `decode(repeat('ab', 32), 'hex')`;

describeWithStack('the github migration', () => {
  it('forces row level security, a project policy on installations and none for tenants on deliveries', async () => {
    const db = await dbs.fresh('migrated');
    const forced = await superuser(
      `select count(*) from pg_class where relnamespace = 'app'::regnamespace
         and relname in (${NAMES}) and relrowsecurity and relforcerowsecurity;`,
      db.name,
    );
    expect(forced.trim()).toBe('2');
    const policies = await superuser(
      `select string_agg(tablename || ' ' || policyname || ' ' || cmd || ' ' ||
         array_to_string(roles, '+'), ',' order by tablename)
       from pg_policies where schemaname = 'app' and tablename in (${NAMES});`,
      db.name,
    );
    expect(policies.trim()).toBe(
      'github_installations tenant_isolation ALL drefyn_app,github_webhook_deliveries webhook_access ALL drefyn_app',
    );
    const grants = await superuser(
      `select grantee || ' ' || table_name || ' ' || string_agg(privilege_type, '+' order by privilege_type)
         from information_schema.role_table_grants
        where table_name in (${NAMES}) and grantee <> 'drefyn_owner'
        group by grantee, table_name order by 1;`,
      db.name,
    );
    expect(grants.trim().split('\n')).toEqual([
      'drefyn_app github_installations DELETE+INSERT+SELECT+UPDATE',
      'drefyn_app github_webhook_deliveries DELETE+INSERT+SELECT',
    ]);
  });

  it('has the keys it needs and nothing wider', async () => {
    const db = await dbs.fresh('migrated');
    const keys = await superuser(
      `select conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid)
         from pg_constraint
        where conrelid in (select oid from pg_class where relnamespace = 'app'::regnamespace
                             and relname in (${NAMES}))
          and contype in ('p', 'u', 'f') order by 1;`,
      db.name,
    );
    expect(keys.trim().split('\n')).toEqual([
      'github_installations github_installations_pkey PRIMARY KEY (organization_id, project_id, installation_id)',
      'github_installations github_installations_project_fkey FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id)',
      'github_webhook_deliveries github_webhook_deliveries_body_key UNIQUE (body_sha256)',
      'github_webhook_deliveries github_webhook_deliveries_pkey PRIMARY KEY (delivery_id)',
    ]);
  });

  it('keeps installation ids positive and the repository list short and full', async () => {
    const db = await seeded();
    expect(await refusal(db, installation('1', `'{4001,4002}'`))).toBe('');
    expect(await refusal(db, installation('1', `'{4001}'`))).toContain('github_installations_pkey');
    expect(await refusal(db, installation('0', `'{4001}'`))).toContain(
      'github_installations_installation_id_check',
    );
    for (const repositories of [
      `'{}'`,
      `'{0}'`,
      `'{1,null}'`,
      `'{{1},{2}}'`,
      `(select array_agg(n) from generate_series(1, 101) n)`,
    ]) {
      expect(await refusal(db, installation('2', repositories))).toContain(
        'github_installations_repository_ids_check',
      );
    }
    expect(
      await refusal(db, installation('3', `'{1}'`, '01a14984-4476-77ce-9335-639999999999')),
    ).toContain('github_installations_project_fkey');
  });

  it('stores a delivery once by id and once by body, with a GitHub event name', async () => {
    const db = await dbs.fresh('migrated');
    expect(await refusal(db, delivery(id(10), DIGEST))).toBe('');
    expect(await refusal(db, delivery(id(10), `decode(repeat('cd', 32), 'hex')`))).toContain(
      'github_webhook_deliveries_pkey',
    );
    expect(await refusal(db, delivery(id(11), DIGEST))).toContain(
      'github_webhook_deliveries_body_key',
    );
    expect(await refusal(db, delivery(id(12), `decode('ab', 'hex')`))).toContain(
      'github_webhook_deliveries_body_sha256_check',
    );
    expect(
      await refusal(db, delivery(id(13), `decode(repeat('ef', 32), 'hex')`, 'Push Event')),
    ).toContain('github_webhook_deliveries_event_check');
  });

  it('reverts cleanly and applies again', async () => {
    const db = await dbs.fresh('migrated');
    await step(db, ['migrate', 'down', String(stepsBack())]);
    const left = await superuser(
      `select count(*) from pg_class where relnamespace = 'app'::regnamespace
         and relname like 'github\\_%';`,
      db.name,
    );
    expect(left.trim()).toBe('0');
    await step(db, ['migrate', 'up']);
    const back = await superuser(
      `select count(*) from pg_tables where schemaname = 'app' and tablename in (${NAMES});`,
      db.name,
    );
    expect(back.trim()).toBe('2');
  });
});

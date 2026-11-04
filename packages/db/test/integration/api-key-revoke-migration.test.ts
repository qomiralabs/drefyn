import { expect, it } from 'vitest';
import { describeFailure, migrate, shippedMigrations } from './support/cli.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { query } from './support/sql.ts';
import { superuser } from './support/stack.ts';

const dbs = databases();

const USER = '01a14984-4476-77ce-9335-1290000000a1';
const ORG = '01a14984-4476-77ce-9335-1290000001a1';
const MEMBER = '01a14984-4476-77ce-9335-1290000003a1';
const PROJECT = '01a14984-4476-77ce-9335-1290000002a1';
const LIVE = '01a14984-4476-77ce-9335-1290000004a1';
const OWNERLESS = '01a14984-4476-77ce-9335-1290000004b1';
const REVOKED = '01a14984-4476-77ce-9335-1290000004c1';

// Steps back to just before the revoke migration, however many have landed after it.
function stepsBack(): number {
  const shipped = shippedMigrations();
  const at = shipped.findIndex((file) => file.endsWith('_api_key_revoke.sql'));
  expect(at).toBeGreaterThanOrEqual(0);
  return shipped.length - at;
}

const keyValues = (id: string, createdBy: string, listed: 'all' | 'listed') =>
  `('${id}', '${ORG}', 'CI', decode(repeat('ab', 32), 'hex'), 'a1b2', array['docs:read'],
    '${listed}', ${createdBy}, 'k-${id}', decode(repeat('cd', 32), 'hex'))`;

const down = async (db: TestDatabase) => {
  const result = await migrate(['migrate', 'down', String(stepsBack())], { url: db.owner });
  expect(result.code, describeFailure(result)).toBe(0);
};

const up = async (db: TestDatabase) => {
  const result = await migrate(['migrate', 'up'], { url: db.owner });
  expect(result.code, describeFailure(result)).toBe(0);
};

const seed = (db: TestDatabase) =>
  superuser(
    `insert into app.users (id, email, email_normalized, email_verified_at)
       values ('${USER}', 'm@example.com', 'm@example.com', now());
     insert into app.organizations (organization_id, name, plan_tier)
       values ('${ORG}', 'A', 'self_hosted');
     insert into app.memberships (id, organization_id, user_id, role)
       values ('${MEMBER}', '${ORG}', '${USER}', 'owner');
     insert into app.projects (id, organization_id, product, slug, name)
       values ('${PROJECT}', '${ORG}', 'docs', 'handbook', 'Handbook');`,
    db.name,
  );

const keys = async (db: TestDatabase) =>
  superuser('select id from app.api_keys order by id;', db.name);

describeWithStack('the API key revoke migration', () => {
  // Migrations run as drefyn_owner, which forced row level security hides these rows from, so
  // a plain update or delete would quietly change nothing.
  it('revokes a key that already has no creator, and leaves the others live', async () => {
    const db = await dbs.fresh('migrated');
    await down(db);
    await seed(db);
    await superuser(
      `insert into app.api_keys (id, organization_id, name, secret_hash, display_suffix, scopes,
         project_scope, created_by, idempotency_key, request_hash)
       values ${keyValues(LIVE, `'${MEMBER}'`, 'all')}, ${keyValues(OWNERLESS, 'null', 'all')};`,
      db.name,
    );
    await up(db);
    expect(
      await superuser(
        `select string_agg((revoked_at is not null)::text, ',' order by id) from app.api_keys;`,
        db.name,
      ),
    ).toBe('false,true');
  });

  it('leaves no revoked key behind on the way down, and keeps the live ones', async () => {
    const db = await dbs.fresh('migrated');
    await seed(db);
    await superuser(
      `insert into app.api_keys (id, organization_id, name, secret_hash, display_suffix, scopes,
         project_scope, created_by, idempotency_key, request_hash)
       values ${keyValues(LIVE, `'${MEMBER}'`, 'all')},
              ${keyValues(REVOKED, `'${MEMBER}'`, 'listed')};
       insert into app.api_key_projects (organization_id, api_key_id, target_project_id)
         values ('${ORG}', '${REVOKED}', '${PROJECT}');
       update app.api_keys set revoked_at = now() where id = '${REVOKED}';`,
      db.name,
    );
    expect((await keys(db)).split('\n').map((l) => l.trim())).toEqual([LIVE, REVOKED]);
    await down(db);
    expect((await keys(db)).trim()).toBe(LIVE);
    expect(await superuser('select count(*) from app.api_key_projects;', db.name)).toBe('0');
  });

  it('forces row level security again in both directions', async () => {
    const db = await dbs.fresh('migrated');
    const forced = () =>
      query<{ forced: boolean }>(
        db.owner,
        `select relforcerowsecurity as forced from pg_class where oid = 'app.api_keys'::regclass`,
      );
    expect((await forced())[0]?.forced).toBe(true);
    await down(db);
    expect((await forced())[0]?.forced).toBe(true);
    await up(db);
    expect((await forced())[0]?.forced).toBe(true);
  });

  it('gives drefyn_app its delete grant back on the way down', async () => {
    const db = await dbs.fresh('migrated');
    const can = () =>
      superuser(`select has_table_privilege('drefyn_app', 'app.api_keys', 'delete');`, db.name);
    expect(await can()).toBe('f');
    await down(db);
    expect(await can()).toBe('t');
  });
});

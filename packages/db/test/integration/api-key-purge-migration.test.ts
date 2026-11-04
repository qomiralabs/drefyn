import { expect, it } from 'vitest';
import { describeFailure, migrate, shippedMigrations } from './support/cli.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { superuser } from './support/stack.ts';

const dbs = databases();

const USER = '01a14984-4476-77ce-9335-1300000000a1';
const ORG = '01a14984-4476-77ce-9335-1300000001a1';
const MEMBER = '01a14984-4476-77ce-9335-1300000003a1';
const LIVE = '01a14984-4476-77ce-9335-1300000004a1';
const REVOKED = '01a14984-4476-77ce-9335-1300000004b1';

// psql ends its output with a newline.
const scalar = async (sql: string, db: TestDatabase) => (await superuser(sql, db.name)).trim();

const seed = (db: TestDatabase) =>
  superuser(
    `insert into app.users (id, email, email_normalized, email_verified_at)
       values ('${USER}', 'm@example.com', 'm@example.com', now());
     insert into app.organizations (organization_id, name, plan_tier)
       values ('${ORG}', 'A', 'self_hosted');
     insert into app.memberships (id, organization_id, user_id, role)
       values ('${MEMBER}', '${ORG}', '${USER}', 'owner');
     insert into app.api_keys (id, organization_id, name, secret_hash, display_suffix, scopes,
         project_scope, created_by, idempotency_key, request_hash, created_at, revoked_at)
       select v.id::uuid, '${ORG}', 'CI', decode(repeat('ab', 32), 'hex'), 'a1b2',
              array['docs:read'], 'all', '${MEMBER}', 'k-' || v.id,
              decode(repeat('cd', 32), 'hex'), now() - interval '200 days', v.revoked_at
         from (values ('${LIVE}', null::timestamptz),
                      ('${REVOKED}', now() - interval '100 days')) v(id, revoked_at);`,
    db.name,
  );

// Steps back to just before this migration, however many have landed after it.
function stepsBack(): number {
  const shipped = shippedMigrations();
  const at = shipped.findIndex((file) => file.endsWith('_api_key_purge.sql'));
  expect(at).toBeGreaterThanOrEqual(0);
  return shipped.length - at;
}

const down = async (db: TestDatabase) => {
  const result = await migrate(['migrate', 'down', String(stepsBack())], { url: db.owner });
  expect(result.code, describeFailure(result)).toBe(0);
};

const up = async (db: TestDatabase) => {
  const result = await migrate(['migrate', 'up'], { url: db.owner });
  expect(result.code, describeFailure(result)).toBe(0);
};

const state = (db: TestDatabase) =>
  scalar(
    `select has_table_privilege('drefyn_auth', 'app.api_keys', 'delete')::text || '|' ||
            has_any_column_privilege('drefyn_auth', 'app.api_keys', 'select')::text || '|' ||
            (select count(*) from pg_policy where polrelid = 'app.api_keys'::regclass
              and polname in ('auth_expire', 'auth_expire_read'))::text || '|' ||
            (to_regclass('app.api_keys_revoked_at_idx') is not null)::text;`,
    db,
  );

describeWithStack('the API key purge migration', () => {
  it('adds the grants, the policies and the partial index', async () => {
    const db = await dbs.fresh('migrated');
    expect(await state(db)).toBe('true|true|2|true');
    expect(
      await scalar(
        `select pg_get_expr(indpred, indrelid) from pg_index
          where indexrelid = 'app.api_keys_revoked_at_idx'::regclass;`,
        db,
      ),
    ).toBe('(revoked_at IS NOT NULL)');
  });

  it('removes all of them on the way down and touches no key', async () => {
    const db = await dbs.fresh('migrated');
    await seed(db);
    await down(db);
    expect(await state(db)).toBe('false|false|0|false');
    expect(
      await scalar(
        `select string_agg(id::text || ':' || (revoked_at is not null)::text, ',' order by id)
           from app.api_keys;`,
        db,
      ),
    ).toBe(`${LIVE}:false,${REVOKED}:true`);
  });

  it('comes back up with the same state', async () => {
    const db = await dbs.fresh('migrated');
    await down(db);
    await up(db);
    expect(await state(db)).toBe('true|true|2|true');
  });

  it('leaves row level security forced in both directions', async () => {
    const db = await dbs.fresh('migrated');
    const forced = () =>
      scalar(`select relforcerowsecurity from pg_class where oid = 'app.api_keys'::regclass;`, db);
    expect(await forced()).toBe('t');
    await down(db);
    expect(await forced()).toBe('t');
  });
});

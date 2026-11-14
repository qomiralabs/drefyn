import { expect, it } from 'vitest';
import { ALLOW_LISTS } from '../../src/allow-lists.ts';
import { describeFailure, migrate, shippedMigrations } from './support/cli.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { superuser } from './support/stack.ts';
import { catalogProblems } from './support/tenancy.ts';

const dbs = databases();

const USER = '01a14984-4476-77ce-9335-1280000006a1';
const ORG = '01a14984-4476-77ce-9335-1280000006a2';
const CONN = '01a14984-4476-77ce-9335-1280000006a3';
const TABLES = ['app.sso_connections', 'app.sso_domains', 'app.sso_identities', 'app.sso_states'];
const COLUMNS = [
  'organizations.sso_enforcement',
  'organizations.sso_enforcement_since',
  'sessions.sso_connection_id',
  'sessions.sso_organization_id',
];

const step = async (db: TestDatabase, args: readonly string[]) => {
  const result = await migrate(args, { url: db.owner });
  expect(result.code, describeFailure(result)).toBe(0);
};

// However many have landed after it.
function stepsBack(): number {
  const shipped = shippedMigrations();
  const at = shipped.findIndex((file) => file.endsWith('_sso_tables.sql'));
  expect(at).toBeGreaterThanOrEqual(0);
  return shipped.length - at;
}

const present = async (db: TestDatabase) =>
  (
    await superuser(
      `select string_agg((to_regclass(t) is not null)::text, ',') from unnest(array['${TABLES.join("','")}']) t;
       select string_agg(exists (select from pg_attribute a
                                  where a.attrelid = ('app.' || split_part(c, '.', 1))::regclass
                                    and a.attname = split_part(c, '.', 2) and not a.attisdropped)::text, ',')
         from unnest(array['${COLUMNS.join("','")}']) c;`,
      db.name,
    )
  )
    .trim()
    .replace(/\n/g, '|');

const methods = async (db: TestDatabase) =>
  (
    await superuser(
      `select coalesce(string_agg(method, ',' order by method), '-') from app.sessions
        where user_id = '${USER}';`,
      db.name,
    )
  ).trim();

const session = (method: string) =>
  `insert into app.sessions (user_id, secret_hash, method, authenticated_at, expires_at)
     values ('${USER}', decode(repeat('ab', 32), 'hex'), '${method}', now(), now() + interval '1 day');`;

const ssoSession = () =>
  `insert into app.sessions (user_id, secret_hash, method, authenticated_at, expires_at,
       sso_connection_id, sso_organization_id)
     values ('${USER}', decode(repeat('cd', 32), 'hex'), 'sso', now(), now() + interval '1 day',
             '${CONN}', '${ORG}');`;

describeWithStack('the sso migration', () => {
  it('reverts cleanly, applies over rows written before it, and applies again', async () => {
    const db = await dbs.fresh('migrated');
    const all = 'true,true,true,true|true,true,true,true';
    expect(await present(db)).toBe(all);
    await superuser(
      `insert into app.users (id, email, email_normalized, email_verified_at)
         values ('${USER}', 'ssom@example.com', 'ssom@example.com', now());
       insert into app.organizations (organization_id, name, plan_tier, sso_enforcement, sso_enforcement_since)
         values ('${ORG}', 'A', 'self_hosted', 'everyone', now());
       insert into app.sso_connections (id, organization_id, protocol, display_name, idempotency_key)
         values ('${CONN}', '${ORG}', 'oidc', 'Okta', 'k1');
       ${ssoSession()} ${session('email')}`,
      db.name,
    );

    await step(db, ['migrate', 'down', String(stepsBack())]);
    expect(await present(db)).toBe('false,false,false,false|false,false,false,false');
    // The older reader throws on sso, so the down signs those sessions out and keeps the rest.
    expect(await methods(db)).toBe('email');
    await expect(superuser(`begin; ${session('sso')} rollback;`, db.name)).rejects.toThrow(
      /sessions_method_check/,
    );

    // The organization and session written by the older schema take the defaults.
    await step(db, ['migrate', 'up']);
    expect(await present(db)).toBe(all);
    expect(
      (
        await superuser(
          `select sso_enforcement || ',' || coalesce(sso_enforcement_since::text, '-')
             from app.organizations where organization_id = '${ORG}';
           select coalesce(sso_connection_id::text, '-') from app.sessions where user_id = '${USER}';`,
          db.name,
        )
      ).trim(),
    ).toBe('off,-\n-');
    await superuser(
      `begin;
       insert into app.sso_connections (id, organization_id, protocol, display_name, idempotency_key)
         values ('${CONN}', '${ORG}', 'oidc', 'Okta', 'k1');
       ${ssoSession()}
       rollback;`,
      db.name,
    );
    expect(await catalogProblems(db.owner, ALLOW_LISTS)).toEqual([]);
  });
});

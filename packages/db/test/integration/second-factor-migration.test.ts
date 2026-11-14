import { expect, it } from 'vitest';
import { ALLOW_LISTS } from '../../src/allow-lists.ts';
import { describeFailure, migrate, shippedMigrations } from './support/cli.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { superuser } from './support/stack.ts';
import { catalogProblems } from './support/tenancy.ts';

const dbs = databases();

const USER = '01a14984-4476-77ce-9335-1280000003a1';
const TABLES = ['app.totp_credentials', 'app.recovery_codes', 'app.factor_challenges'];

const step = async (db: TestDatabase, args: readonly string[]) => {
  const result = await migrate(args, { url: db.owner });
  expect(result.code, describeFailure(result)).toBe(0);
};

// However many have landed after it.
function stepsBack(): number {
  const shipped = shippedMigrations();
  const at = shipped.findIndex((file) => file.endsWith('_second_factor_tables.sql'));
  expect(at).toBeGreaterThanOrEqual(0);
  return shipped.length - at;
}

const present = async (db: TestDatabase) =>
  (
    await superuser(
      `select string_agg((to_regclass(t) is not null)::text, ',') from unnest(array['${TABLES.join("','")}']) t;`,
      db.name,
    )
  ).trim();

const stepUps = async (db: TestDatabase) =>
  (
    await superuser(
      `select string_agg(coalesce(step_up_method, '-'), ',' order by step_up_method nulls last)
         from app.sessions where user_id = '${USER}';`,
      db.name,
    )
  ).trim();

const session = (stepUp: string) =>
  `insert into app.sessions (user_id, secret_hash, method, step_up_method, authenticated_at, expires_at)
     values ('${USER}', decode(repeat('ab', 32), 'hex'), 'password', '${stepUp}', now(), now() + interval '1 day');`;

describeWithStack('the second factor migration', () => {
  it('reverts cleanly and applies again', async () => {
    const db = await dbs.fresh('migrated');
    expect(await present(db)).toBe('true,true,true');
    await superuser(
      `insert into app.users (id, email, email_normalized, email_verified_at)
         values ('${USER}', 'sfm@example.com', 'sfm@example.com', now());
       insert into app.totp_credentials (user_id, key_id, secret_nonce, secret_sealed)
         values ('${USER}', 'k1', decode(repeat('00', 12), 'hex'), decode(repeat('00', 36), 'hex'));
       ${session('totp')} ${session('recovery_code')} ${session('email')}`,
      db.name,
    );

    await step(db, ['migrate', 'down', String(stepsBack())]);
    expect(await present(db)).toBe('false,false,false');
    // The older reader throws on the new values, so the down leaves none behind. Clearing the
    // step up only asks for a fresh one; the sessions themselves stay signed in.
    expect(await stepUps(db)).toBe('email,-,-');
    await expect(superuser(`begin; ${session('totp')} rollback;`, db.name)).rejects.toThrow(
      /sessions_step_up_method_check/,
    );

    await step(db, ['migrate', 'up']);
    expect(await present(db)).toBe('true,true,true');
    await superuser(`begin; ${session('recovery_code')} rollback;`, db.name);
    expect(await catalogProblems(db.owner, ALLOW_LISTS)).toEqual([]);
  });
});

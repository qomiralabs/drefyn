import { beforeAll, beforeEach, expect, it } from 'vitest';
import { runExpiryJob, type AuthDatabase } from '../../src/index.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { superuser } from './support/stack.ts';
import { authUrl, pools, rawSession } from './support/tenancy.ts';

const dbs = databases();
const open = pools();

const USER = '01a14984-4476-77ce-9335-1400000000a1';
const ORG_A = '01a14984-4476-77ce-9335-1400000001a1';
const ORG_B = '01a14984-4476-77ce-9335-1400000001b1';
const MEMBER = '01a14984-4476-77ce-9335-1400000003a1';

let db: TestDatabase;
let auth: AuthDatabase;

const key = (id: string, org: string, revoked: string, creator = 'null') =>
  `insert into app.api_keys (id, organization_id, name, secret_hash, display_suffix, scopes,
     project_scope, created_by, idempotency_key, request_hash, created_at, revoked_at)
   values ('${id}', '${org}', 'secret looking name', decode(repeat('ab', 32), 'hex'), 'a1b2',
     array['docs:read'], 'all', ${creator}, 'k-${id}', decode(repeat('cd', 32), 'hex'),
     now() - interval '200 days', ${revoked});`;

const id = (n: number) => `01a14984-4476-77ce-9335-14000004${n.toString(16).padStart(4, '0')}`;

const remaining = async () =>
  (await superuser('select count(*) from app.api_keys;', db.name)).trim();

describeWithStack('the expiry job on the real database', () => {
  beforeAll(async () => {
    db = await dbs.fresh('migrated');
    auth = await open.auth(authUrl(db));
    await superuser(
      `insert into app.users (id, email, email_normalized, email_verified_at)
         values ('${USER}', 'j@example.com', 'j@example.com', now());
       insert into app.organizations (organization_id, name, plan_tier) values
         ('${ORG_A}', 'A', 'self_hosted'), ('${ORG_B}', 'B', 'self_hosted');
       insert into app.memberships (id, organization_id, user_id, role)
         values ('${MEMBER}', '${ORG_A}', '${USER}', 'owner');`,
      db.name,
    );
  });

  beforeEach(async () => {
    await superuser(
      `delete from app.api_keys;
       update app.scheduled_jobs set next_run_at = now(), last_run_at = null;`,
      db.name,
    );
  });

  it('deletes past the limit, says which organization, and leaves the rest', async () => {
    await superuser(
      [
        key(id(1), ORG_A, `now() - interval '91 days'`),
        key(id(2), ORG_A, `now() - interval '100 days'`),
        key(id(3), ORG_B, `now() - interval '91 days'`),
        key(id(4), ORG_A, `now() - interval '89 days'`),
        key(id(5), ORG_A, 'null', `'${MEMBER}'`),
      ].join('\n'),
      db.name,
    );
    const result = await runExpiryJob(auth);
    expect(result).toMatchObject({ ran: true, backlog: false });
    if (!result.ran) throw new Error('expected a run');
    expect(result.counts['api_keys']).toBe(3);
    expect(
      [...result.organizations].sort((a, b) => a.organizationId.localeCompare(b.organizationId)),
    ).toEqual([
      { table: 'api_keys', organizationId: ORG_A, deleted: 2 },
      { table: 'api_keys', organizationId: ORG_B, deleted: 1 },
    ]);
    expect(await remaining()).toBe('2');
  });

  it('records the run, so one query shows the job is alive', async () => {
    await runExpiryJob(auth);
    const row = await superuser(
      `select last_run_at is not null, next_run_at > now() + interval '59 minutes'
         from app.scheduled_jobs where name = 'auth_expiry';`,
      db.name,
    );
    expect(row.trim()).toBe('t|t');
  });

  it('does nothing until the next run is due', async () => {
    await runExpiryJob(auth);
    await superuser(key(id(6), ORG_A, `now() - interval '91 days'`), db.name);
    await expect(runExpiryJob(auth)).resolves.toEqual({ ran: false });
    expect(await remaining()).toBe('1');
  });

  it('gives one of many servers the turn and the others stand down at once', async () => {
    await superuser(key(id(7), ORG_A, `now() - interval '91 days'`), db.name);
    const results = await Promise.all(Array.from({ length: 8 }, () => runExpiryJob(auth)));
    expect(results.filter((r) => r.ran)).toHaveLength(1);
    expect(await remaining()).toBe('0');
  });

  it('stands down while another server is mid run, without waiting for it', async () => {
    const holder = await rawSession('auth', db.name);
    try {
      await holder.query('begin');
      await holder.query(`select 1 from app.scheduled_jobs for update`);
      const started = Date.now();
      await expect(runExpiryJob(auth)).resolves.toEqual({ ran: false });
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      await holder.query('rollback');
      await holder.end();
    }
  });

  it('leaves the job due and the rows in place when a run fails', async () => {
    await superuser(
      `${key(id(8), ORG_A, `now() - interval '91 days'`)}
       alter table app.oauth_states rename to oauth_states_away;`,
      db.name,
    );
    try {
      await expect(runExpiryJob(auth)).rejects.toThrow();
      expect(await remaining()).toBe('1');
      const row = await superuser(
        `select last_run_at is null, next_run_at <= now() from app.scheduled_jobs;`,
        db.name,
      );
      expect(row.trim()).toBe('t|t');
    } finally {
      await superuser('alter table app.oauth_states_away rename to oauth_states;', db.name);
    }
    await expect(runExpiryJob(auth)).resolves.toMatchObject({ ran: true });
    expect(await remaining()).toBe('0');
  });

  it('stays due while a full batch shows more rows are waiting', async () => {
    await superuser(
      [1, 2, 3].map((n) => key(id(10 + n), ORG_A, `now() - interval '91 days'`)).join('\n'),
      db.name,
    );
    await expect(runExpiryJob(auth, { batchSize: 2 })).resolves.toMatchObject({
      ran: true,
      backlog: true,
    });
    await expect(runExpiryJob(auth, { batchSize: 2 })).resolves.toMatchObject({
      ran: true,
      backlog: false,
    });
    expect(await remaining()).toBe('0');
  });

  it('cannot purge a live key that organization work tried to backdate', async () => {
    await superuser(key(id(20), ORG_A, 'null', `'${MEMBER}'`), db.name);
    const app = await rawSession('app', db.name);
    try {
      await app.query('begin');
      await app.query("select set_config('drefyn.organization_id', $1, true)", [ORG_A]);
      await app.query("select set_config('drefyn.project_id', '', true)");
      await expect(
        app.query(`update app.api_keys set revoked_at = '2000-01-01' where id = '${id(20)}'`),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await app.query('rollback');
      await app.end();
    }
    await runExpiryJob(auth);
    expect(await remaining()).toBe('1');
  });

  it('keeps the job row away from organization work', async () => {
    const app = await rawSession('app', db.name);
    try {
      await expect(app.query('select 1 from app.scheduled_jobs')).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await app.end();
    }
  });
});

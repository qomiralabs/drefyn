import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { expect, it } from 'vitest';
import { BOOTSTRAPPED } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { repoRoot, stack, superuser } from './support/stack.ts';

// Read on demand, so the other files still run against a deploy/.env from before the role.
function authPassword(): string {
  const text = readFileSync(join(repoRoot, 'deploy', '.env'), 'utf8');
  const value = /^DREFYN_AUTH_PASSWORD=(.*)$/m.exec(text)?.[1] ?? '';
  if (value === '') throw new Error('deploy/.env has no DREFYN_AUTH_PASSWORD');
  return value;
}

async function connectAsAuth(database: string): Promise<string> {
  const client = new pg.Client({
    host: '127.0.0.1',
    port: Number(stack().port),
    user: 'drefyn_auth',
    password: authPassword(),
    database,
  });
  await client.connect();
  try {
    const { rows } = await client.query<{ who: string }>('select current_user as who');
    return rows[0]?.who ?? '';
  } finally {
    await client.end();
  }
}

describeWithStack('the drefyn_auth role from the bootstrap', () => {
  it('has exactly the listed attributes and nothing else', async () => {
    const row = await superuser(
      `select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit,
              rolreplication, rolconnlimit, rolconfig is null,
              (select count(*) from pg_db_role_setting s where s.setrole = r.oid),
              (select count(*) from pg_auth_members m where m.member = r.oid or m.roleid = r.oid)
         from pg_roles r where rolname = 'drefyn_auth';`,
    );
    // login, no superuser, no bypassrls, no createrole, no createdb, noinherit, no
    // replication, no connection limit, no settings, no memberships either way.
    expect(row.trim()).toBe('t|f|f|f|f|f|f|-1|t|0|0');
  });

  it('may connect to drefyn and owns nothing', async () => {
    const row = await superuser(
      `select has_database_privilege('drefyn_auth', '${BOOTSTRAPPED}', 'CONNECT'),
              has_database_privilege('drefyn_auth', '${BOOTSTRAPPED}', 'TEMP'),
              has_database_privilege('drefyn_auth', '${BOOTSTRAPPED}', 'CREATE'),
              (select count(*) from pg_shdepend d join pg_roles r on r.oid = d.refobjid
                where r.rolname = 'drefyn_auth' and d.deptype = 'o');`,
    );
    expect(row.trim()).toBe('t|f|f|0');
  });

  it('may not connect to postgres or template1', async () => {
    const row = await superuser(
      `select string_agg(datname || ':' || has_database_privilege('drefyn_auth', datname, 'CONNECT')::text, ',' order by datname)
         from pg_database where datname in ('postgres', 'template1');`,
    );
    expect(row.trim()).toBe('postgres:false,template1:false');
  });

  it('logs in over TCP with the password in deploy/.env', async () => {
    expect(await connectAsAuth(BOOTSTRAPPED)).toBe('drefyn_auth');
  });
});

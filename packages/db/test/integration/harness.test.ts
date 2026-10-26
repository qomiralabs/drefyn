import { describe, expect, inject, it } from 'vitest';
import { recordedName, shippedMigrations } from './support/cli.ts';
import {
  BOOTSTRAPPED,
  cloneDatabase,
  databases,
  dropDatabase,
  newName,
} from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { migrationState, query } from './support/sql.ts';
import { superuser, urlFor } from './support/stack.ts';

const dbs = databases();

describe('per file databases', () => {
  it('gives this file its own database, cloned in under 200 ms', async () => {
    const db = await dbs.fresh('base');
    const templates = inject('templates');
    const rows = await query<{ name: string }>(db.owner, 'select current_database() as name');
    expect(rows[0]?.name).toBe(db.name);
    expect([BOOTSTRAPPED, templates.base, templates.migrated]).not.toContain(db.name);
    console.info(`clone ${db.name} from ${templates.base}: ${db.cloneMs} ms`);
    expect(db.cloneMs).toBeLessThan(200);
  });

  it('never hands out the same database twice', async () => {
    const a = await dbs.fresh('base');
    const b = await dbs.fresh('base');
    expect(a.name).not.toBe(b.name);
    const [ra, rb] = await Promise.all([
      query<{ n: string }>(a.owner, 'select current_database() as n'),
      query<{ n: string }>(b.owner, 'select current_database() as n'),
    ]);
    expect(ra[0]?.n).not.toBe(rb[0]?.n);
  });

  it('drops a clone afterwards', async () => {
    const name = newName('drop');
    await cloneDatabase(inject('templates').base, name);
    await dropDatabase(name);
    const left = await superuser(`select count(*) from pg_database where datname = '${name}';`);
    expect(left.trim()).toBe('0');
  });

  // A clone without the bootstrap's database grants and settings would test a looser
  // database than the one the stack runs.
  it('carries the bootstrap database grants and search_path', async () => {
    const db = await dbs.fresh('base');
    const acl = await superuser(
      `select (select datacl::text from pg_database where datname = '${db.name}') =
              (select datacl::text from pg_database where datname = '${BOOTSTRAPPED}');`,
    );
    expect(acl.trim()).toBe('t');
    const rows = await query<{ path: string; temp: boolean; create: boolean }>(
      db.app,
      `select current_setting('search_path') as path,
              has_database_privilege(current_database(), 'TEMP') as temp,
              has_database_privilege(current_database(), 'CREATE') as create`,
    );
    expect(rows[0]).toEqual({ path: 'app, extensions', temp: false, create: false });
  });

  it('builds the migrated template with the real command', async () => {
    const db = await dbs.fresh('migrated');
    const state = await migrationState(db.owner);
    expect(state?.applied).toEqual(shippedMigrations().map(recordedName));
  });

  it('runs every clone on the compose server and pgvector 0.8.7', async () => {
    const db = await dbs.fresh('base');
    const rows = await query<{ v: number; ext: string }>(
      urlFor('owner', db.name),
      `select current_setting('server_version_num')::int as v,
              (select extversion from pg_extension where extname = 'vector') as ext`,
    );
    expect(rows[0]?.v).toBeGreaterThanOrEqual(180006);
    expect(rows[0]?.ext).toBe('0.8.7');
  });
});

// create database ... template fails while anyone is connected to the template, and a
// backend lingers briefly after the CLI exits, so templates are closed once built.
describeWithStack('templates', () => {
  it('both refuse connections once built', async () => {
    const { base, migrated } = inject('templates');
    const rows = await superuser(
      `select datname || '=' || datallowconn from pg_database
        where datname in ('${base}', '${migrated}') order by datname;`,
    );
    expect(rows.trim().split('\n').sort()).toEqual([`${base}=false`, `${migrated}=false`].sort());
  });

  it('have no backend connected', async () => {
    const { base, migrated } = inject('templates');
    const count = await superuser(
      `select count(*) from pg_stat_activity where datname in ('${base}', '${migrated}');`,
    );
    expect(count.trim()).toBe('0');
  });

  // Clones do not inherit allow_connections, so tests still reach their own databases.
  it('hand out clones that accept connections', async () => {
    const db = await dbs.fresh('migrated');
    const rows = await superuser(
      `select datallowconn from pg_database where datname = '${db.name}';`,
    );
    expect(rows.trim()).toBe('t');
  });
});

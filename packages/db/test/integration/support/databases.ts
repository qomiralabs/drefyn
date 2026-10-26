import { randomBytes } from 'node:crypto';
import { afterAll, inject } from 'vitest';
import { removeFixtureDirs } from './cli.ts';
import { superuser, urlFor } from './stack.ts';

// The bootstrapped database every template starts from.
export const BOOTSTRAPPED = 'drefyn';

export interface TestDatabase {
  readonly name: string;
  readonly cloneMs: number;
  readonly owner: string;
  readonly app: string;
  readonly reader: string;
}

export interface Templates {
  readonly base: string;
  readonly migrated: string;
  readonly migratedError: string | null;
}

declare module 'vitest' {
  export interface ProvidedContext {
    templates: Templates;
  }
}

const ident = (name: string) => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new Error(`unsafe database name ${name}`);
  return `"${name}"`;
};

// CREATE DATABASE copies the contents but not the database's own grants or settings, so the
// bootstrap's CONNECT grants, revoked TEMP and search_path are copied over from drefyn.
export async function cloneDatabase(template: string, name: string): Promise<number> {
  const out = await superuser(`
\\timing on
create database ${ident(name)} template ${ident(template)} strategy wal_log;
\\timing off
update pg_database set datacl = (select datacl from pg_database where datname = '${BOOTSTRAPPED}')
  where datname = '${name}';
do $$
declare setting text;
begin
  for setting in
    select unnest(setconfig) from pg_db_role_setting
    where setrole = 0 and setdatabase = (select oid from pg_database where datname = '${BOOTSTRAPPED}')
  loop
    execute format('alter database %I set %s', '${name}',
      regexp_replace(setting, '^([^=]+)=(.*)$', '\\1 = \\2'));
  end loop;
end $$;
`);
  const ms = /Time: ([\d.]+) ms/.exec(out)?.[1];
  if (ms === undefined) throw new Error(`no clone time in psql output: ${out}`);
  return Number(ms);
}

export async function dropDatabase(name: string): Promise<void> {
  await superuser(`drop database if exists ${ident(name)} with (force);`);
}

export function newName(label: string): string {
  return `drefyn_test_${label}_${randomBytes(4).toString('hex')}`;
}

// Every test that changes state gets its own clone; all of them are dropped after the file.
export function databases() {
  const created: string[] = [];
  afterAll(async () => {
    removeFixtureDirs();
    for (const name of created.splice(0)) await dropDatabase(name);
  });
  return {
    created,
    async fresh(kind: 'base' | 'migrated'): Promise<TestDatabase> {
      const absent = inject('stackAbsent');
      if (absent !== null) throw new Error(`no compose stack to clone from: ${absent}`);
      const templates = inject('templates');
      if (kind === 'migrated' && templates.migratedError !== null) {
        throw new Error(templates.migratedError);
      }
      const name = newName(kind === 'base' ? 'b' : 'm');
      created.push(name);
      const cloneMs = await cloneDatabase(templates[kind], name);
      return {
        name,
        cloneMs,
        owner: urlFor('owner', name),
        app: urlFor('app', name),
        reader: urlFor('reader', name),
      };
    },
  };
}

// Every database a run creates starts with this, and nothing else on the stack does.
export const TEST_PREFIX = 'drefyn_test_';

// Drops every database whose name starts with the prefix. The prefix is required, so a test
// can sweep its own names without touching the clones other files hold right now; only the
// global setup sweeps the bare TEST_PREFIX, while it holds the run lock and before any file runs.
export async function sweepDatabases(prefix: string): Promise<string[]> {
  if (!prefix.startsWith(TEST_PREFIX) || !/^[a-z0-9_]+$/.test(prefix)) {
    throw new Error(`refusing to sweep databases outside ${TEST_PREFIX}: ${prefix}`);
  }
  const names = (await superuser('select datname from pg_database order by datname;'))
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => name.startsWith(prefix));
  for (const name of names) await dropDatabase(name);
  return names;
}

// create database ... template fails while anyone is connected to the template, and a
// backend lingers briefly after a client exits, so templates are closed and then watched
// until empty. Clones do not inherit allow_connections.
export async function closeTemplate(name: string, timeoutMs = 10_000): Promise<void> {
  await superuser(`alter database ${ident(name)} with allow_connections false;`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const count = await superuser(
      `select count(*) from pg_stat_activity where datname = '${name}';`,
    );
    if (count.trim() === '0') return;
    if (Date.now() > deadline) {
      throw new Error(
        `template ${name} still has ${count.trim()} backends after ${String(timeoutMs)} ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { TestProject } from 'vitest/node';
import {
  inCi,
  migrateCli,
  project,
  repoRoot,
  run,
  stackAbsence,
  superuser,
  urlFor,
} from './stack.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    authStackAbsent: string | null;
    authTemplate: string;
  }
}

export const PREFIX = 'drefyn_authit_';
// Not the db harness key, so the two packages can run against one stack at the same time.
const LOCK_KEY = '4207140129';

const ident = (name: string) => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new Error(`unsafe database name ${name}`);
  return `"${name}"`;
};

export const newName = (label: string) => `${PREFIX}${label}_${randomBytes(4).toString('hex')}`;

// CREATE DATABASE copies contents but not the database's grants or settings, so those are
// copied from the bootstrapped drefyn database too.
export async function cloneDatabase(template: string, name: string): Promise<void> {
  await superuser(`
create database ${ident(name)} template ${ident(template)} strategy wal_log;
update pg_database set datacl = (select datacl from pg_database where datname = 'drefyn')
  where datname = '${name}';
do $$
declare setting text;
begin
  for setting in
    select unnest(setconfig) from pg_db_role_setting
    where setrole = 0 and setdatabase = (select oid from pg_database where datname = 'drefyn')
  loop
    execute format('alter database %I set %s', '${name}',
      regexp_replace(setting, '^([^=]+)=(.*)$', '\\1 = \\2'));
  end loop;
end $$;
`);
}

export async function dropDatabase(name: string): Promise<void> {
  await superuser(`drop database if exists ${ident(name)} with (force);`);
}

async function closeTemplate(name: string): Promise<void> {
  await superuser(`alter database ${ident(name)} with allow_connections false;`);
  const deadline = Date.now() + 10_000;
  while (
    (await superuser(`select count(*) from pg_stat_activity where datname = '${name}';`)) !== '0'
  ) {
    if (Date.now() > deadline) throw new Error(`template ${name} still has backends`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// Held by a psql that stays open for the run; if the run dies, the lock goes with it.
function takeLock(): Promise<() => Promise<void>> {
  const child = spawn(
    'docker',
    [
      'compose',
      '-p',
      project(),
      '-f',
      `${repoRoot}/deploy/compose.yaml`,
      'exec',
      '-T',
      'postgres',
      'psql',
      '--no-psqlrc',
      '-qAt',
      '-U',
      'postgres',
      '-d',
      'postgres',
    ],
    { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const closed = new Promise<void>((resolve) =>
    child.on('close', () => {
      resolve();
    }),
  );
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('could not take the auth integration lock in time'));
    }, 15_000);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      out += chunk;
      if (!out.includes('\n')) return;
      clearTimeout(timer);
      if (out.startsWith('t')) {
        resolve(async () => {
          child.stdin.end();
          await closed;
        });
      } else {
        child.kill();
        reject(new Error('another auth integration run holds the lock on this stack'));
      }
    });
    child.stdin.write(`select pg_try_advisory_lock(${LOCK_KEY});\n`);
  });
}

export default async function setup(project_: TestProject) {
  const absent = await stackAbsence();
  if (absent !== null && inCi())
    throw new Error(`auth integration tests need the stack in CI: ${absent}`);
  project_.provide('authStackAbsent', absent);
  project_.provide('authTemplate', '');
  if (absent !== null) return;
  const release = await takeLock();
  try {
    const left = (await superuser('select datname from pg_database order by datname;'))
      .split('\n')
      .filter((name) => name.startsWith(PREFIX));
    for (const name of left) await dropDatabase(name);
    const template = newName('tpl');
    await cloneDatabase('drefyn', template);
    const migrated = await run(process.execPath, [migrateCli, 'migrate', 'up'], {
      env: {
        PATH: process.env['PATH'] ?? '',
        DREFYN_MIGRATION_DATABASE_URL: urlFor('owner', template),
        DREFYN_DATABASE_SSL: 'disable',
      },
    });
    if (migrated.code !== 0)
      throw new Error(`migrate up exited ${String(migrated.code)}: ${migrated.stderr}`);
    await closeTemplate(template);
    project_.provide('authTemplate', template);
    return async () => {
      try {
        await dropDatabase(template);
      } finally {
        await release();
      }
    };
  } catch (error) {
    await release();
    throw error;
  }
}

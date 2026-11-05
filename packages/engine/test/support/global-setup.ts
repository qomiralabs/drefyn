import { randomBytes } from 'node:crypto';
import type { TestProject } from 'vitest/node';
import { inCi, migrateCli, run, stackAbsence, superuser, urlFor } from './stack.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    engineStackAbsent: string | null;
    engineDatabase: string;
  }
}

// CREATE DATABASE copies contents but not the database's grants or settings, so those are
// copied from the bootstrapped drefyn database too.
const cloneBootstrapped = (name: string) =>
  superuser(`
create database "${name}" template drefyn strategy wal_log;
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

// One database for the run: every file seeds its own organization, so RLS keeps them apart.
export default async function setup(project: TestProject) {
  const absent = await stackAbsence();
  if (absent !== null && inCi())
    throw new Error(`engine integration tests need the stack in CI: ${absent}`);
  project.provide('engineStackAbsent', absent);
  project.provide('engineDatabase', '');
  if (absent !== null) return;
  const name = `drefyn_engineit_${randomBytes(4).toString('hex')}`;
  await cloneBootstrapped(name);
  const drop = () => superuser(`drop database if exists "${name}" with (force);`);
  try {
    const migrated = await run(process.execPath, [migrateCli, 'migrate', 'up'], {
      env: {
        PATH: process.env['PATH'] ?? '',
        DREFYN_MIGRATION_DATABASE_URL: urlFor('owner', name),
        DREFYN_DATABASE_SSL: 'disable',
      },
    });
    if (migrated.code !== 0)
      throw new Error(`migrate up exited ${String(migrated.code)}: ${migrated.stderr}`);
  } catch (error) {
    await drop();
    throw error;
  }
  project.provide('engineDatabase', name);
  return async () => {
    await drop();
  };
}

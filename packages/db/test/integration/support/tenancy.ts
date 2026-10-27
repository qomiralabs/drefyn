import { sql, type RawBuilder, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll } from 'vitest';
import { ALLOW_LISTS, type AllowLists } from '../../../src/allow-lists.ts';
import { checkCatalog, type CatalogProblem } from '../../../src/catalog-check.ts';
import {
  closeDatabase,
  createDatabase,
  createPublishedDatabase,
  parseDatabaseConfig,
  parsePublishedReaderConfig,
  type Database,
  type PublishedDatabase,
} from '../../../src/index.ts';
import { publishedTableSql, tenantTableSql } from '../../../src/tenant-sql.ts';
import { describeFailure, fixtureMigrations, migrate, migration } from './cli.ts';
import { cloneDatabase, closeTemplate, newName, type TestDatabase } from './databases.ts';
import { superuser, urlFor, type Role } from './stack.ts';
import { withClient } from './sql.ts';

export const FIXTURE_FILE = '9000000000001_tenancy_fixtures.sql';

// Test only tables, built with the same helpers a real migration uses. Never shipped.
export function fixtureSchemaUp(): string {
  return [
    tenantTableSql({
      name: 'fixture_projects',
      scope: 'organization',
      columns: ['name text not null'],
      constraints: ['unique (organization_id, id)'],
    }),
    tenantTableSql({
      name: 'fixture_notes',
      scope: 'project',
      columns: [
        'body text not null',
        'slug text',
        'amount_cents bigint not null default 0 check (amount_cents >= 0)',
      ],
      constraints: ['unique (organization_id, slug)'],
      projectsTable: 'fixture_projects',
    }),
    tenantTableSql({
      name: 'fixture_members',
      scope: 'organization',
      columns: ['email text not null'],
      constraints: ['unique (organization_id, email)'],
    }),
    tenantTableSql({
      name: 'fixture_drafts',
      scope: 'project',
      columns: ['body text not null'],
      projectsTable: 'fixture_projects',
    }),
    publishedTableSql({
      name: 'fixture_published',
      columns: ['body text not null'],
      projectsTable: 'fixture_projects',
    }),
  ].join('\n\n');
}

export const FIXTURE_DOWN = [
  'drop table app.fixture_published;',
  'drop table app.fixture_drafts;',
  'drop table app.fixture_members;',
  'drop table app.fixture_notes;',
  'drop table app.fixture_projects;',
].join('\n');

// The shipped lists plus the fixture published table, which only tests ever create.
export const FIXTURE_ALLOW_LISTS: AllowLists = {
  ...ALLOW_LISTS,
  publishedTables: [
    ...ALLOW_LISTS.publishedTables,
    { name: 'app.fixture_published', reason: 'test fixture, never shipped' },
  ],
};

// Shipped migrations, the fixture file, then any extra files, which sort after it.
export function fixtureDir(extra: Readonly<Record<string, string>> = {}): string {
  return fixtureMigrations({
    [FIXTURE_FILE]: migration(fixtureSchemaUp(), FIXTURE_DOWN),
    ...extra,
  });
}

export async function migrateUp(
  db: TestDatabase,
  extra: Readonly<Record<string, string>> = {},
): Promise<void> {
  const result = await migrate(['migrate', 'up'], {
    url: db.owner,
    migrationsDir: fixtureDir(extra),
  });
  if (result.code !== 0) throw new Error(`fixture migration failed:\n${describeFailure(result)}`);
}

interface Dbs {
  readonly created: string[];
  fresh(kind: 'base' | 'migrated'): Promise<TestDatabase>;
}

export function testDatabase(name: string, cloneMs = 0): TestDatabase {
  return {
    name,
    cloneMs,
    owner: urlFor('owner', name),
    app: urlFor('app', name),
    reader: urlFor('reader', name),
  };
}

// One migrated database with the fixtures per file, closed and used as a template, so each
// test gets its own copy in tens of milliseconds.
export function fixtureTemplate(dbs: Dbs) {
  let template: Promise<string> | undefined;
  const build = async () => {
    const db = await dbs.fresh('migrated');
    await migrateUp(db);
    await closeTemplate(db.name);
    return db.name;
  };
  return async (): Promise<TestDatabase> => {
    template ??= build();
    const name = newName('f');
    dbs.created.push(name);
    const ms = await cloneDatabase(await template, name);
    return testDatabase(name, ms);
  };
}

export function appConfig(url: string, overrides: Readonly<Record<string, string>> = {}) {
  return parseDatabaseConfig({
    DREFYN_DATABASE_URL: url,
    DREFYN_DATABASE_SSL: 'disable',
    ...overrides,
  });
}

export function readerConfig(url: string, overrides: Readonly<Record<string, string>> = {}) {
  return parsePublishedReaderConfig({
    DREFYN_PUBLIC_READER_DATABASE_URL: url,
    DREFYN_DATABASE_SSL: 'disable',
    ...overrides,
  });
}

// Pools opened by a file, closed after it even when a test fails halfway.
export function pools() {
  const open: (Database | PublishedDatabase)[] = [];
  afterAll(async () => {
    for (const db of open.splice(0)) await closeDatabase(db).catch(() => undefined);
  });
  return {
    async app(url: string, overrides: Readonly<Record<string, string>> = {}): Promise<Database> {
      const db = await createDatabase(appConfig(url, overrides));
      open.push(db);
      return db;
    },
    async reader(
      url: string,
      overrides: Readonly<Record<string, string>> = {},
    ): Promise<PublishedDatabase> {
      const db = await createPublishedDatabase(readerConfig(url, overrides));
      open.push(db);
      return db;
    },
  };
}

export async function rows<R, DB>(tx: Transaction<DB>, query: RawBuilder<R>): Promise<R[]> {
  return [...(await query.execute(tx)).rows];
}

export async function one<R, DB>(tx: Transaction<DB>, query: RawBuilder<R>): Promise<R> {
  const [row] = await rows(tx, query);
  if (row === undefined) throw new Error('expected a row');
  return row;
}

export const context = sql<{ org: string | null; project: string | null; pid: number }>`
  select app.current_org()::text as org, app.current_project()::text as project,
         pg_backend_pid() as pid`;

// Writes as drefyn_app on a plain connection with transaction local settings, so seeding
// does not depend on the code under test.
export async function seed(
  url: string,
  organization: string,
  project: string | null,
  statements: readonly { text: string; values?: readonly unknown[] }[],
): Promise<void> {
  await withClient(url, async (client) => {
    await client.query('begin');
    try {
      await client.query("select set_config('drefyn.organization_id', $1, true)", [organization]);
      await client.query("select set_config('drefyn.project_id', $1, true)", [project ?? '']);
      for (const s of statements) await client.query(s.text, [...(s.values ?? [])]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
}

export async function seedProject(url: string, organization: string, project: string) {
  await seed(url, organization, null, [
    {
      text: 'insert into app.fixture_projects (id, organization_id, name) values ($1, $2, $3)',
      values: [project, organization, `project ${project.slice(-4)}`],
    },
  ]);
}

export async function catalogProblems(
  url: string,
  allow: AllowLists = FIXTURE_ALLOW_LISTS,
): Promise<readonly CatalogProblem[]> {
  return withClient(url, (client) => checkCatalog(client, allow));
}

// SQLSTATE and message of a failure, from the error or what it wraps.
export function failure(error: unknown): {
  code: string | undefined;
  message: string;
  routine?: string;
} {
  const seen: unknown[] = [];
  let current: unknown = error;
  while (current instanceof Error && !seen.includes(current)) {
    seen.push(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      const routine = (current as { routine?: unknown }).routine;
      return typeof routine === 'string'
        ? { code, message: current.message, routine }
        : { code, message: current.message };
    }
    current = current.cause;
  }
  return { code: undefined, message: error instanceof Error ? error.message : String(error) };
}

export async function rawSession(role: Role, database: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: urlFor(role, database) });
  await client.connect();
  return client;
}

// Backends a role has open on a database right now. Only the superuser sees the state of
// another role's sessions.
export async function backendsOf(role: string, database: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(role) || !/^[a-z][a-z0-9_]*$/.test(database)) {
    throw new Error(`unsafe name ${role} ${database}`);
  }
  const out = await superuser(
    `select pid || '|' || coalesce(state, '') from pg_stat_activity
      where usename = '${role}' and datname = '${database}' and backend_type = 'client backend';`,
  );
  return out
    .split('\n')
    .filter((line) => line.includes('|'))
    .map((line) => {
      const [pid, state] = line.split('|');
      return { pid: Number(pid), state: state ?? '' };
    });
}

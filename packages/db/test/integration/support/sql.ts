import pg from 'pg';
import {
  CHECKSUMS_TABLE,
  MIGRATE_LOCK_KEY,
  MIGRATIONS_SCHEMA,
  MIGRATIONS_TABLE,
} from '../../../src/constants.ts';

export async function withClient<T>(
  url: string,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

export async function query<R extends pg.QueryResultRow>(
  url: string,
  text: string,
  values: readonly unknown[] = [],
): Promise<R[]> {
  return withClient(url, async (client) => (await client.query<R>(text, [...values])).rows);
}

// A held session, for locks that must outlive one statement.
export async function session(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

export const MIGRATIONS = `${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`;
export const CHECKSUMS = `${MIGRATIONS_SCHEMA}.${CHECKSUMS_TABLE}`;

export interface MigrationState {
  readonly applied: readonly string[];
  readonly checksums: readonly { name: string; sha256: string }[];
}

// What the runner has recorded, or null when it never created its tables.
export async function migrationState(ownerUrl: string): Promise<MigrationState | null> {
  return withClient(ownerUrl, async (client) => {
    const { rows } = await client.query<{ migrations: string | null; checksums: string | null }>(
      'select to_regclass($1)::text as migrations, to_regclass($2)::text as checksums',
      [MIGRATIONS, CHECKSUMS],
    );
    const found = rows[0];
    if (found?.migrations == null && found?.checksums == null) return null;
    const applied =
      found.migrations == null
        ? []
        : (
            await client.query<{ name: string }>(`select name from ${MIGRATIONS} order by id`)
          ).rows.map((r) => r.name);
    const checksums =
      found.checksums == null
        ? []
        : (
            await client.query<{ name: string; sha256: string }>(
              `select name, sha256 from ${CHECKSUMS} order by name`,
            )
          ).rows;
    return { applied, checksums };
  });
}

const high = MIGRATE_LOCK_KEY >> 32n;
const low = MIGRATE_LOCK_KEY & 0xffffffffn;

// Backends in this database holding or waiting for the migrate advisory lock.
export async function migrateLockRows(url: string): Promise<{ pid: number; granted: boolean }[]> {
  return query<{ pid: number; granted: boolean }>(
    url,
    `select pid, granted from pg_locks
      where locktype = 'advisory' and classid = $1::oid and objid = $2::oid and objsubid = 1
        and database = (select oid from pg_database where datname = current_database())`,
    [high.toString(), low.toString()],
  );
}

export async function holdMigrateLock(url: string): Promise<pg.Client> {
  const client = await session(url);
  await client.query('select pg_advisory_lock($1::bigint)', [MIGRATE_LOCK_KEY.toString()]);
  return client;
}

export async function tableExists(url: string, qualified: string): Promise<boolean> {
  const rows = await query<{ found: string | null }>(url, 'select to_regclass($1)::text as found', [
    qualified,
  ]);
  return rows[0]?.found != null;
}

export interface ExtensionState {
  readonly extension: unknown;
  readonly schema: unknown;
  readonly objects: unknown;
}

// Everything about pgvector and schema extensions a migration could have changed.
export async function extensionState(url: string): Promise<ExtensionState> {
  return withClient(url, async (client) => {
    const extension = (
      await client.query(
        `select extname, extversion, extnamespace::regnamespace::text as schema,
                pg_get_userbyid(extowner) as owner
           from pg_extension order by extname`,
      )
    ).rows;
    const schema = (
      await client.query(
        `select nspname, pg_get_userbyid(nspowner) as owner, nspacl::text as acl
           from pg_namespace where nspname = 'extensions'`,
      )
    ).rows;
    const objects = (
      await client.query(
        `select 'proc' as kind, count(*)::int as n from pg_proc where pronamespace = 'extensions'::regnamespace
         union all select 'type', count(*)::int from pg_type where typnamespace = 'extensions'::regnamespace
         union all select 'class', count(*)::int from pg_class where relnamespace = 'extensions'::regnamespace
         union all select 'operator', count(*)::int from pg_operator where oprnamespace = 'extensions'::regnamespace`,
      )
    ).rows;
    return { extension, schema, objects };
  });
}

export async function backendPid(client: pg.Client): Promise<number> {
  const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
  const pid = rows[0]?.pid;
  if (pid === undefined) throw new Error('no backend pid');
  return pid;
}

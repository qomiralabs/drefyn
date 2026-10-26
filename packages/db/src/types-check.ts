import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { USAGE, parseMigrateArgs } from './args.ts';
import { parseMigrationConfig, type Env, type MigrationConfig } from './config.ts';
import { MIGRATIONS_SCHEMA, MIGRATIONS_TABLE } from './constants.ts';
import { DbError } from './errors.ts';
import { MigrateError, exitCodeFor, outcomeOf } from './outcome.ts';
import { clientConfig } from './pg-session.ts';
import { runMigrate, type Output } from './run.ts';
import { compareRenderings, renderSchema, type CatalogColumn } from './schema-types.ts';

export const committedTypesPath = fileURLToPath(new URL('./schema.generated.ts', import.meta.url));

// What check:types reads from the database it is pointed at.
export interface TypesDatabase {
  // Rows in app.pgmigrations, or null when the table does not exist.
  migrationRows(): Promise<number | null>;
  columns(): Promise<CatalogColumn[]>;
  close(): Promise<void>;
}

export interface CheckTypesOptions {
  readonly argv: readonly string[];
  readonly env: Env;
  readonly stdout: Output;
  readonly stderr: Output;
  readonly open?: (config: MigrationConfig) => Promise<TypesDatabase>;
  readonly migrate?: (argv: readonly string[]) => Promise<number>;
  readonly typesPath?: string;
}

const COLUMNS = `
select c.relname as "table", a.attname as "column", r.typname as type,
       et.typname as "elementType",
       (select array_agg(e.enumlabel::text order by e.enumsortorder) from pg_enum e
         where e.enumtypid = coalesce(et.oid, r.oid)) as "enumLabels",
       not a.attnotnull as nullable,
       (a.atthasdef or a.attidentity <> '' or a.attgenerated <> '') as "hasDefault"
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
  join pg_type t on t.oid = a.atttypid
  join pg_type r on r.oid = case when t.typtype = 'd' then t.typbasetype else t.oid end
  left join pg_type et on r.typcategory = 'A' and et.oid = r.typelem
 where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm') and not c.relispartition
 order by c.relname, a.attnum`;

export async function openTypesDatabase(config: MigrationConfig): Promise<TypesDatabase> {
  const client = new pg.Client(clientConfig(config));
  client.on('error', () => undefined);
  await client.connect();
  return {
    async migrationRows() {
      const qualified = `${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`;
      const found = await client.query<{ found: boolean }>(
        'select to_regclass($1) is not null as found',
        [qualified],
      );
      if (found.rows[0]?.found !== true) return null;
      const count = await client.query<{ n: number }>(
        `select count(*)::int as n from ${qualified}`,
      );
      return count.rows[0]?.n ?? 0;
    },
    async columns() {
      return (await client.query<CatalogColumn>(COLUMNS, [MIGRATIONS_SCHEMA])).rows;
    },
    async close() {
      await client.end();
    },
  };
}

interface Parsed {
  readonly write: boolean;
  readonly migrateArgv: string[];
}

function parseArgs(argv: readonly string[]): Parsed {
  const write = argv.includes('--write');
  const rest = argv.filter((arg) => arg !== '--write');
  // The same folder rule as drefyn migrate, so the two can never read different files.
  const command = parseMigrateArgs(['migrate', 'up', ...rest]);
  if (write && argv.indexOf('--write') !== argv.lastIndexOf('--write')) {
    throw new MigrateError('failed', `--write given twice\n${USAGE}`);
  }
  return {
    write,
    migrateArgv: [
      'migrate',
      'up',
      ...(command.migrationsDir === undefined ? [] : ['--migrations-dir', command.migrationsDir]),
    ],
  };
}

async function readCommitted(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

// Migrates the empty database in DREFYN_MIGRATION_DATABASE_URL and compares its app tables
// with the committed types. Exits 0 when they match and 1 naming each table that differs.
export async function runCheckTypes(options: CheckTypesOptions): Promise<number> {
  const { stdout, stderr } = options;
  try {
    const args = parseArgs(options.argv);
    const config = parseMigrationConfig(options.env);
    const open = options.open ?? openTypesDatabase;

    // It writes to the database it is given, so a live one pointed at by mistake must stop
    // here, before anything runs.
    const before = await open(config);
    try {
      const rows = await before.migrationRows();
      if (rows !== null && rows > 0) {
        throw new MigrateError(
          'failed',
          `the database is not empty: ${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE} has ${String(rows)} rows, so nothing was run. check:types migrates the database it is given; point it at a fresh clone of the bootstrapped database.`,
        );
      }
    } finally {
      await before.close();
    }

    const migrate =
      options.migrate ??
      ((argv: readonly string[]) => runMigrate({ argv, env: options.env, stdout, stderr }));
    const code = await migrate(args.migrateArgv);
    if (code !== exitCodeFor('done')) return code;

    const after = await open(config);
    let expected: string;
    try {
      expected = renderSchema(await after.columns());
    } finally {
      await after.close();
    }

    const path = options.typesPath ?? committedTypesPath;
    if (args.write) {
      await writeFile(path, expected);
      stdout.write(`check:types: wrote ${path}\n`);
      return exitCodeFor('done');
    }
    const difference = compareRenderings(await readCommitted(path), expected);
    if (difference.tables.length === 0 && !difference.elsewhere) {
      stdout.write('check:types: committed types match the migrated schema\n');
      return exitCodeFor('done');
    }
    const what =
      difference.tables.length > 0
        ? `these app tables differ from the committed types: ${difference.tables.join(', ')}`
        : 'the committed types file was changed outside its tables';
    throw new MigrateError(
      'failed',
      `${what}\nRegenerate against a fresh database with: pnpm --filter @drefyn/db check:types --write`,
    );
  } catch (error) {
    const text =
      error instanceof DbError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : 'unknown error';
    stderr.write(`check:types: ${text}\n`);
    return exitCodeFor(outcomeOf(error) === 'lock_held' ? 'lock_held' : 'failed');
  }
}

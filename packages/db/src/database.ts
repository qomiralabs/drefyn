import type { OrganizationRef, TenantRef } from '@drefyn/tenancy';
import {
  DefaultQueryExecutor,
  DummyDriver,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  SingleConnectionProvider,
  Transaction,
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Kysely,
  type QueryResult,
} from 'kysely';
import pg from 'pg';
import type { DatabaseConfig } from './config.ts';
import { DbError } from './errors.ts';
import { toDbError } from './pg-errors.ts';
import { hidePgEnvironment, sslOption } from './pg-session.ts';
import type { PublishedSchema } from './published.ts';
import { assertRoleSafe, readRoleFacts, type PoolKind } from './role-check.ts';
import type { Schema } from './schema.generated.ts';
import {
  APP_TIMEOUT_MAX_MS,
  READER_TIMEOUT_MAX_MS,
  tenantSettings,
  transactionTimeout,
  type TenantSettings,
} from './tenant-context.ts';
import { toSafeInteger } from './integers.ts';

export type TenantContext = TenantRef | OrganizationRef;

declare const appBrand: unique symbol;
declare const readerBrand: unique symbol;

// Opaque: holds the pool and never hands it out.
export interface Database {
  readonly [appBrand]: true;
}

export interface PublishedDatabase {
  readonly [readerBrand]: true;
}

export interface TransactionOptions {
  readonly timeoutMs?: number;
}

interface PoolState {
  readonly kind: PoolKind;
  readonly pool: pg.Pool;
  readonly statementTimeoutMs: number;
  closed: boolean;
  closing: Promise<void> | undefined;
}

// The handles are empty frozen objects; everything lives here, out of reach of callers.
const appPools = new WeakMap<object, PoolState>();
const readerPools = new WeakMap<object, PoolState>();

const URL_KEYS: Readonly<Record<PoolKind, string>> = {
  app: 'DREFYN_DATABASE_URL',
  reader: 'DREFYN_PUBLIC_READER_DATABASE_URL',
};

const TIMEOUT_MAX: Readonly<Record<PoolKind, number>> = {
  app: APP_TIMEOUT_MAX_MS,
  reader: READER_TIMEOUT_MAX_MS,
};

// Bounds the startup role check, which runs outside any tenant transaction.
const SESSION_STATEMENT_TIMEOUT_MS = 10_000;
// Work that stalls with a transaction open would hold a connection and its locks forever.
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

const INT8 = 20;
const INT8_ARRAY = 1016;

function parseInt8(text: string): number {
  try {
    return toSafeInteger(text, 'bigint value', { allowNegative: true });
  } catch {
    throw new DbError(
      'INTEGER_INVALID',
      'a bigint value read from the database is outside the safe integer range',
    );
  }
}

// The driver's own array parser gives the elements as text, nested for more dimensions.
type TextParser = (text: string) => unknown;
const driverParser = pg.types.getTypeParser as (oid: number, format: string) => TextParser;
const parseTextArray = driverParser(INT8_ARRAY, 'text');

function int8Elements(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(int8Elements);
  return typeof value === 'string' ? parseInt8(value) : value;
}

function parseInt8Array(text: string): unknown {
  return int8Elements(parseTextArray(text));
}

// Set per pool rather than globally, so nothing else in the process changes how it reads
// bigint, and a value past 2^53 - 1 fails instead of losing precision.
const TYPES = {
  getTypeParser: (oid: number, format = 'text'): TextParser => {
    if (format === 'text' && oid === INT8) return parseInt8;
    if (format === 'text' && oid === INT8_ARRAY) return parseInt8Array;
    return driverParser(oid, format);
  },
};

// Pool clients are built lazily, long after createDatabase returns, so each one hides the
// PG* variables itself.
class IsolatedClient extends pg.Client {
  constructor(config?: string | pg.ClientConfig) {
    const restore = hidePgEnvironment();
    try {
      super(config);
    } finally {
      restore();
    }
  }
}

export function poolConfig(config: DatabaseConfig, kind: PoolKind): pg.PoolConfig {
  const url = new URL(config.url);
  const password = decodeURIComponent(url.password);
  return {
    Client: IsolatedClient,
    host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
    port: url.port === '' ? 5432 : Number(url.port),
    user: decodeURIComponent(url.username),
    // A function, so neither PGPASSWORD nor a pgpass file can stand in.
    password: () => Promise.resolve(password),
    database: decodeURIComponent(url.pathname.slice(1)),
    ssl: sslOption(config.ssl),
    application_name: kind === 'app' ? 'drefyn-app' : 'drefyn-public-reader',
    max: config.poolMax,
    connectionTimeoutMillis: config.poolWaitMs,
    idleTimeoutMillis: 30_000,
    statement_timeout: SESSION_STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
    keepAlive: true,
    types: TYPES,
  };
}

// For failures to get a connection at all. Anything the mapping does not know, such as a TLS
// handshake the server refused, still means no connection.
function unavailable(error: unknown, kind: PoolKind): unknown {
  const mapped = toDbError(error, URL_KEYS[kind]);
  if (mapped instanceof DbError) return mapped;
  return new DbError('DB_UNAVAILABLE', `could not reach the database from ${URL_KEYS[kind]}`);
}

async function open(config: DatabaseConfig, kind: PoolKind): Promise<object> {
  if (config.statementTimeoutMs > TIMEOUT_MAX[kind]) {
    throw new DbError(
      'DB_CONFIG_INVALID',
      `the ${kind} pool statement timeout must be at most ${String(TIMEOUT_MAX[kind])} ms`,
    );
  }
  const pool = new pg.Pool(poolConfig(config, kind));
  // An idle client that loses its connection is dropped by the pool; without a listener
  // the error would crash the process.
  pool.on('error', () => undefined);
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    await Promise.allSettled([pool.end()]);
    throw unavailable(error, kind);
  }
  try {
    assertRoleSafe(await readRoleFacts(client), kind);
  } catch (error) {
    client.release(true);
    await Promise.allSettled([pool.end()]);
    throw toDbError(error, URL_KEYS[kind]);
  }
  client.release();
  const handle = Object.freeze({});
  const state: PoolState = {
    kind,
    pool,
    statementTimeoutMs: config.statementTimeoutMs,
    closed: false,
    closing: undefined,
  };
  (kind === 'app' ? appPools : readerPools).set(handle, state);
  return handle;
}

// Runs the startup role check: refuses a superuser, a BYPASSRLS role, an owner of app
// tables, a member of any role, any role or database setting beyond the bootstrap's, and
// any role other than drefyn_app.
export async function createDatabase(config: DatabaseConfig): Promise<Database> {
  return (await open(config, 'app')) as Database;
}

// The same checks for drefyn_public_reader, for public, unauthenticated paths.
export async function createPublishedDatabase(config: DatabaseConfig): Promise<PublishedDatabase> {
  return (await open(config, 'reader')) as PublishedDatabase;
}

export async function closeDatabase(db: Database | PublishedDatabase): Promise<void> {
  const state = appPools.get(db) ?? readerPools.get(db);
  if (state === undefined) return;
  state.closed = true;
  state.closing ??= state.pool.end();
  await state.closing;
}

// The one connection a transaction runs on. Closing it makes every later query through the
// same Transaction object fail, so a tx kept past its work cannot reach the next tenant's
// transaction on the same pooled connection.
class TransactionConnection implements DatabaseConnection {
  #client: pg.PoolClient | undefined;
  #failure: unknown;

  constructor(client: pg.PoolClient) {
    this.#client = client;
  }

  get failure(): unknown {
    return this.#failure;
  }

  close(): void {
    this.#client = undefined;
  }

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const client = this.#client;
    if (client === undefined) {
      throw new Error('this transaction has ended; use the transaction only inside its work');
    }
    try {
      const result = await client.query<R & pg.QueryResultRow>(compiled.sql, [
        ...compiled.parameters,
      ]);
      const counted = ['INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(result.command);
      const affected = counted ? result.rowCount : null;
      return affected === null
        ? { rows: result.rows }
        : { rows: result.rows, numAffectedRows: BigInt(affected) };
    } catch (error) {
      this.#failure ??= error;
      throw error;
    }
  }

  // eslint-disable-next-line require-yield -- refuses before yielding anything
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    await Promise.resolve();
    throw new Error('streaming is not supported inside a tenant transaction');
  }
}

// Compiles Postgres SQL and never connects: the driver is a dummy, because the connection
// comes from runTransaction.
class TransactionDialect implements Dialect {
  createAdapter(): PostgresAdapter {
    return new PostgresAdapter();
  }

  createDriver(): DummyDriver {
    return new DummyDriver();
  }

  createIntrospector(db: Kysely<unknown>): PostgresIntrospector {
    return new PostgresIntrospector(db);
  }

  createQueryCompiler(): PostgresQueryCompiler {
    return new PostgresQueryCompiler();
  }
}

const dialect = new TransactionDialect();
const adapter = dialect.createAdapter();
const compiler = dialect.createQueryCompiler();
const driver = dialect.createDriver();

// Kysely only builds and compiles the work's queries. The transaction itself (begin, the
// settings, commit) is run here on the raw client, so nothing in Kysely decides when the
// connection goes back to the pool.
function transactionOn<DB>(connection: TransactionConnection): Transaction<DB> {
  const executor = new DefaultQueryExecutor(
    compiler,
    adapter,
    new SingleConnectionProvider(connection),
    [],
  );
  return new Transaction<DB>({ config: { dialect }, driver, executor, dialect });
}

async function runTransaction<DB, T>(
  state: PoolState,
  settings: TenantSettings,
  timeoutMs: number,
  work: (tx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  let client: pg.PoolClient;
  try {
    client = await state.pool.connect();
  } catch (error) {
    throw unavailable(error, state.kind);
  }
  const connection = new TransactionConnection(client);
  // pg-pool drops its own error listener while a client is checked out, so a connection
  // lost between two statements of the work would otherwise crash the process.
  const events = { lost: false };
  const onError = () => {
    events.lost = true;
  };
  client.on('error', onError);
  // A client whose state is unknown is destroyed instead of going back to the pool.
  let discard = true;
  try {
    // timeoutMs is a validated integer, so it can be part of the text. The settings go in
    // their own statements: one statement with the work was measured to be far slower.
    const begin = state.kind === 'reader' ? 'begin read only' : 'begin';
    await client.query(`${begin}; set local statement_timeout = ${String(timeoutMs)}`);
    await client.query("select set_config('drefyn.organization_id', $1, true)", [
      settings.organizationId,
    ]);
    // Always set, empty for an organization transaction, so a session value the last user
    // of this connection left behind can never stand in.
    await client.query("select set_config('drefyn.project_id', $1, true)", [settings.projectId]);
    let result: T;
    try {
      result = await work(transactionOn<DB>(connection));
    } catch (error) {
      connection.close();
      // A failed rollback leaves the client in an unknown state, so it is destroyed, and the
      // work's own error is the one that matters.
      await client.query('rollback').then(
        () => {
          discard = false;
        },
        () => undefined,
      );
      throw error;
    }
    connection.close();
    const commit = await client.query('commit');
    discard = false;
    // COMMIT of a failed transaction rolls back without an error. Work that caught a SQL
    // error and returned must not look like it succeeded.
    if (commit.command === 'ROLLBACK') {
      throw connection.failure instanceof Error
        ? connection.failure
        : new Error('the transaction failed and was rolled back');
    }
    return result;
  } catch (error) {
    throw toDbError(error, URL_KEYS[state.kind]);
  } finally {
    connection.close();
    client.removeListener('error', onError);
    client.release(discard || events.lost ? true : undefined);
  }
}

function stateOf(pools: WeakMap<object, PoolState>, db: unknown, what: string): PoolState {
  const state = typeof db === 'object' && db !== null ? pools.get(db) : undefined;
  if (state === undefined) {
    throw new DbError(
      'DB_CONFIG_INVALID',
      `${what} needs a database opened by its own constructor`,
    );
  }
  if (state.closed) throw new DbError('DB_UNAVAILABLE', 'the database has been closed');
  return state;
}

// Every query against tenant data runs in here, as drefyn_app, with the organization and
// project set for this transaction only.
export async function withTenant<T>(
  db: Database,
  ctx: TenantContext,
  work: (tx: Transaction<Schema>) => Promise<T>,
  options?: TransactionOptions,
): Promise<T> {
  const state = stateOf(appPools, db, 'withTenant');
  const settings = tenantSettings(ctx, 'organization');
  const timeoutMs = transactionTimeout(
    options?.timeoutMs,
    state.statementTimeoutMs,
    APP_TIMEOUT_MAX_MS,
  );
  return runTransaction(state, settings, timeoutMs, work);
}

// Public, unauthenticated paths. Runs as drefyn_public_reader in a read only transaction;
// the transaction type has only the published tables.
export async function withPublishedReader<T>(
  db: PublishedDatabase,
  tenant: TenantRef,
  work: (tx: Transaction<PublishedSchema>) => Promise<T>,
  options?: TransactionOptions,
): Promise<T> {
  const state = stateOf(readerPools, db, 'withPublishedReader');
  const settings = tenantSettings(tenant, 'project');
  const timeoutMs = transactionTimeout(
    options?.timeoutMs,
    state.statementTimeoutMs,
    READER_TIMEOUT_MAX_MS,
  );
  return runTransaction(state, settings, timeoutMs, work);
}

import type { OrganizationRef, TenantRef, UserRef } from '@drefyn/tenancy';
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
import type { ApiKeyLimiterSchema, AuthSchema, UserSchema } from './contexts.ts';
import { DbError } from './errors.ts';
import { toDbError } from './pg-errors.ts';
import { hidePgEnvironment, sslOption } from './pg-session.ts';
import type { OrganizationSchema, TenantSchema } from './organization.ts';
import type { PublishedSchema } from './published.ts';
import { assertRoleSafe, readRoleFacts, type PoolKind } from './role-check.ts';
import {
  APP_TIMEOUT_MAX_MS,
  AUTH_SETTINGS,
  AUTH_TIMEOUT_MAX_MS,
  READER_TIMEOUT_MAX_MS,
  organizationSettings,
  projectSettings,
  transactionTimeout,
  userSettings,
  type TenantSettings,
} from './tenant-context.ts';
import { toSafeInteger } from './integers.ts';

declare const appBrand: unique symbol;
declare const readerBrand: unique symbol;
declare const authBrand: unique symbol;

// Opaque: holds the pool and never hands it out.
export interface Database {
  readonly [appBrand]: true;
}

export interface PublishedDatabase {
  readonly [readerBrand]: true;
}

export interface AuthDatabase {
  readonly [authBrand]: true;
}

export interface TransactionOptions {
  readonly timeoutMs?: number;
}

export type LogFields = Readonly<Record<string, string | number | boolean>>;

// Events carry ids and the pool kind, never SQL text or values.
export interface DbLogger {
  warn(event: string, fields?: LogFields): void;
}

export interface DatabaseDeps {
  readonly logger?: DbLogger;
}

interface PoolState {
  readonly kind: PoolKind;
  readonly pool: pg.Pool;
  readonly statementTimeoutMs: number;
  readonly logger: DbLogger | undefined;
  closed: boolean;
  closing: Promise<void> | undefined;
}

// The handles are empty frozen objects; everything lives here, out of reach of callers.
// One map per pool kind, so a handle only ever opens its own kind of transaction.
const POOLS: Readonly<Record<PoolKind, WeakMap<object, PoolState>>> = {
  app: new WeakMap(),
  reader: new WeakMap(),
  auth: new WeakMap(),
};

const URL_KEYS: Readonly<Record<PoolKind, string>> = {
  app: 'DREFYN_DATABASE_URL',
  reader: 'DREFYN_PUBLIC_READER_DATABASE_URL',
  auth: 'DREFYN_AUTH_DATABASE_URL',
};

const TIMEOUT_MAX: Readonly<Record<PoolKind, number>> = {
  app: APP_TIMEOUT_MAX_MS,
  reader: READER_TIMEOUT_MAX_MS,
  auth: AUTH_TIMEOUT_MAX_MS,
};

const APPLICATION_NAMES: Readonly<Record<PoolKind, string>> = {
  app: 'drefyn-app',
  reader: 'drefyn-public-reader',
  auth: 'drefyn-auth',
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
    application_name: APPLICATION_NAMES[kind],
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

// Wraps a pool that has already passed the role check. Not exported from the package: it
// exists so tests can drive the transaction rules with a scripted client.
export function databaseOverPool(
  pool: pg.Pool,
  kind: PoolKind,
  options: { readonly statementTimeoutMs: number; readonly logger?: DbLogger },
): Database | PublishedDatabase | AuthDatabase {
  const handle = Object.freeze({});
  const state: PoolState = {
    kind,
    pool,
    statementTimeoutMs: options.statementTimeoutMs,
    logger: options.logger,
    closed: false,
    closing: undefined,
  };
  POOLS[kind].set(handle, state);
  return handle as Database | PublishedDatabase | AuthDatabase;
}

async function open(config: DatabaseConfig, kind: PoolKind, deps: DatabaseDeps): Promise<object> {
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
  return databaseOverPool(pool, kind, {
    statementTimeoutMs: config.statementTimeoutMs,
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  });
}

// Runs the startup role check: refuses a superuser, a BYPASSRLS role, an owner of app
// tables, a member of any role, any role or database setting beyond the bootstrap's, and
// any role other than drefyn_app.
export async function createDatabase(
  config: DatabaseConfig,
  deps: DatabaseDeps = {},
): Promise<Database> {
  return (await open(config, 'app', deps)) as Database;
}

// The same checks for drefyn_public_reader, for public, unauthenticated paths.
export async function createPublishedDatabase(
  config: DatabaseConfig,
  deps: DatabaseDeps = {},
): Promise<PublishedDatabase> {
  return (await open(config, 'reader', deps)) as PublishedDatabase;
}

// The same checks for drefyn_auth, for the sign in path only. Every other role is refused,
// so a misconfigured URL can never give sign in a role with tenant grants.
export async function createAuthDatabase(
  config: DatabaseConfig,
  deps: DatabaseDeps = {},
): Promise<AuthDatabase> {
  return (await open(config, 'auth', deps)) as AuthDatabase;
}

export async function closeDatabase(
  db: Database | PublishedDatabase | AuthDatabase,
): Promise<void> {
  const state = POOLS.app.get(db) ?? POOLS.reader.get(db) ?? POOLS.auth.get(db);
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

// Raised by the context check in the commit string when the work changed the settings.
const CONTEXT_CHANGED = 'DRF01';
// The connection is in a failed transaction: the work caught a SQL error and returned.
const IN_FAILED_TRANSACTION = '25P02';
// "there is no transaction in progress", on COMMIT or ROLLBACK: the work ended it itself.
const NO_TRANSACTION = '25P01';

// Errors and notices both carry the SQLSTATE in code; pg's notices are not Errors.
const sqlState = (value: unknown): unknown => Reflect.get(Object(value), 'code');

// Runs in the same string as COMMIT, so it costs no round trip. The ids are validated
// canonical UUIDs or empty, so they can be part of the text. If the work switched the
// tenant or the user, or ended the transaction and kept going, the settings no longer match
// and the commit never runs.
function contextCheck(settings: TenantSettings): string {
  return `do $$ begin
  if current_setting('drefyn.organization_id', true) is distinct from '${settings.organizationId}'
     or current_setting('drefyn.project_id', true) is distinct from '${settings.projectId}'
     or current_setting('drefyn.user_id', true) is distinct from '${settings.userId}' then
    raise exception 'the tenant context changed inside the transaction' using errcode = '${CONTEXT_CHANGED}';
  end if;
end $$; commit`;
}

// A user or auth transaction has no tenant to log. The user id is left out: logs carry no
// personal data by default, and the caller's own request log can join on it.
function transactionInvalid(state: PoolState, settings: TenantSettings, scope: string): DbError {
  const fields: Record<string, string> = { pool: state.kind };
  if (settings.organizationId !== '') fields['organization_id'] = settings.organizationId;
  else fields['scope'] = scope;
  if (settings.projectId !== '') fields['project_id'] = settings.projectId;
  try {
    state.logger?.warn('db_transaction_invalid', fields);
  } catch {
    // Logging is best effort.
  }
  return new DbError(
    'DB_TRANSACTION_INVALID',
    'the transaction was ended or its tenant changed inside the work',
  );
}

// What a transaction without an organization is for, named in the log when it goes wrong.
type Scope = 'tenant' | 'user' | 'auth' | 'api_key_limiter';

async function runTransaction<DB, T>(
  state: PoolState,
  settings: TenantSettings,
  timeoutMs: number,
  work: (tx: Transaction<DB>) => Promise<T>,
  scope: Scope = 'tenant',
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
  const events = { lost: false, ended: false };
  const onError = () => {
    events.lost = true;
  };
  const onNotice = (notice: unknown) => {
    if (sqlState(notice) === NO_TRANSACTION) events.ended = true;
  };
  client.on('error', onError);
  client.on('notice', onNotice);
  // A client whose state is unknown is destroyed instead of going back to the pool.
  let doubtful = true;
  const rollback = async () => {
    await client.query('rollback').then(
      () => {
        doubtful = false;
      },
      () => undefined,
    );
  };
  try {
    // timeoutMs is a validated integer, so it can be part of the text. The settings go in
    // their own statements: one statement with the work was measured to be far slower.
    const begin = state.kind === 'reader' ? 'begin read only' : 'begin';
    await client.query(`${begin}; set local statement_timeout = ${String(timeoutMs)}`);
    await client.query("select set_config('drefyn.organization_id', $1, true)", [
      settings.organizationId,
    ]);
    // Always set, empty where the entry point has none, so nothing left on the session can
    // stand in.
    await client.query("select set_config('drefyn.project_id', $1, true)", [settings.projectId]);
    await client.query("select set_config('drefyn.user_id', $1, true)", [settings.userId]);
    let result: T;
    try {
      result = await work(transactionOn<DB>(connection));
    } catch (error) {
      connection.close();
      await rollback();
      if (events.ended) {
        doubtful = true;
        throw transactionInvalid(state, settings, scope);
      }
      throw error;
    }
    connection.close();
    try {
      await client.query(contextCheck(settings));
    } catch (error) {
      await rollback();
      const code = sqlState(error);
      if (code === IN_FAILED_TRANSACTION && connection.failure instanceof Error) {
        throw connection.failure;
      }
      if (code === CONTEXT_CHANGED) {
        doubtful = true;
        throw transactionInvalid(state, settings, scope);
      }
      throw error;
    }
    doubtful = false;
    return result;
  } catch (error) {
    throw toDbError(error, URL_KEYS[state.kind]);
  } finally {
    connection.close();
    // Cursors held past commit, session settings, LISTEN, advisory locks and prepared
    // statements all go, so the next tenant on this connection starts clean.
    if (!doubtful && !events.lost) {
      await client.query('discard all').then(
        () => undefined,
        () => {
          doubtful = true;
        },
      );
    }
    client.removeListener('error', onError);
    client.removeListener('notice', onNotice);
    client.release(doubtful || events.lost ? true : undefined);
  }
}

function stateOf(kind: PoolKind, db: unknown, what: string): PoolState {
  const state = typeof db === 'object' && db !== null ? POOLS[kind].get(db) : undefined;
  if (state === undefined) {
    throw new DbError(
      'DB_CONFIG_INVALID',
      `${what} needs a database opened by its own constructor`,
    );
  }
  if (state.closed) throw new DbError('DB_UNAVAILABLE', 'the database has been closed');
  return state;
}

// Project work: runs as drefyn_app with the organization and project set for this
// transaction only. The project is required.
export async function withTenant<T>(
  db: Database,
  tenant: TenantRef & { readonly userId?: never },
  work: (tx: Transaction<TenantSchema>) => Promise<T>,
  options?: TransactionOptions,
): Promise<T> {
  const state = stateOf('app', db, 'withTenant');
  const settings = projectSettings(tenant);
  const timeoutMs = transactionTimeout(
    options?.timeoutMs,
    state.statementTimeoutMs,
    APP_TIMEOUT_MAX_MS,
  );
  return runTransaction(state, settings, timeoutMs, work);
}

// Organization work (members, plans, the credit ledger): no project is set, and project
// tables read as empty, so the wider scope is said out loud at the call site.
export async function withOrganization<T>(
  db: Database,
  org: OrganizationRef & { readonly projectId?: never; readonly userId?: never },
  work: (tx: Transaction<OrganizationSchema>) => Promise<T>,
  options?: TransactionOptions,
): Promise<T> {
  const state = stateOf('app', db, 'withOrganization');
  const settings = organizationSettings(org);
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
  tenant: TenantRef & { readonly userId?: never },
  work: (tx: Transaction<PublishedSchema>) => Promise<T>,
  options?: TransactionOptions,
): Promise<T> {
  const state = stateOf('reader', db, 'withPublishedReader');
  const settings = projectSettings(tenant);
  const timeoutMs = transactionTimeout(
    options?.timeoutMs,
    state.statementTimeoutMs,
    READER_TIMEOUT_MAX_MS,
  );
  return runTransaction(state, settings, timeoutMs, work);
}

// Signed in work that belongs to the person rather than an organization: their own rows, and
// the organizations they belong to. Runs as drefyn_app with only drefyn.user_id set, so
// tenant tables read as empty. Before the work runs, only BEGIN and the settings are sent, so
// a caller that must prove a credential first can make that its first statement.
export async function withUser<T>(
  db: Database,
  user: UserRef & { readonly organizationId?: never; readonly projectId?: never },
  work: (tx: Transaction<UserSchema>) => Promise<T>,
  options?: TransactionOptions,
): Promise<T> {
  const state = stateOf('app', db, 'withUser');
  const settings = userSettings(user);
  const timeoutMs = transactionTimeout(
    options?.timeoutMs,
    state.statementTimeoutMs,
    APP_TIMEOUT_MAX_MS,
  );
  return runTransaction(state, settings, timeoutMs, work, 'user');
}

// The sign in path, before any user or organization is known. Runs as drefyn_auth, whose
// grants reach only the identity tables, with every setting empty.
export async function withAuth<T>(
  db: AuthDatabase,
  work: (tx: Transaction<AuthSchema>) => Promise<T>,
  options?: TransactionOptions,
): Promise<T> {
  const state = stateOf('auth', db, 'withAuth');
  const timeoutMs = transactionTimeout(
    options?.timeoutMs,
    state.statementTimeoutMs,
    AUTH_TIMEOUT_MAX_MS,
  );
  return runTransaction(state, AUTH_SETTINGS, timeoutMs, work, 'auth');
}

// Counting failed API key checks, before any key or organization is proved. Runs as
// drefyn_app with every setting empty; the transaction type names api_key_failures alone, so
// the request's attacker supplied organization can never steer it anywhere else.
export async function withApiKeyLimiter<T>(
  db: Database,
  work: (tx: Transaction<ApiKeyLimiterSchema>) => Promise<T>,
  options?: TransactionOptions,
): Promise<T> {
  const state = stateOf('app', db, 'withApiKeyLimiter');
  const timeoutMs = transactionTimeout(
    options?.timeoutMs,
    state.statementTimeoutMs,
    APP_TIMEOUT_MAX_MS,
  );
  return runTransaction(state, AUTH_SETTINGS, timeoutMs, work, 'api_key_limiter');
}

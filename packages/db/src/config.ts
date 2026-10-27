import { DbError } from './errors.ts';

export type SslMode = 'require' | 'verify-full' | 'disable';

export type Env = Readonly<Record<string, string | undefined>>;

export interface DatabaseConfig {
  readonly url: string;
  readonly poolMax: number;
  readonly poolWaitMs: number;
  readonly statementTimeoutMs: number;
  readonly ssl: SslMode;
}

export interface MigrationConfig {
  readonly url: string;
  readonly ssl: SslMode;
}

const SSL_MODES: readonly SslMode[] = ['require', 'verify-full', 'disable'];

// Public paths serve cached, published content, so a slow query there is a fault.
const READER_STATEMENT_TIMEOUT_MS = 2000;

// Each check returns a reason that names no value: a value may be a password pasted into
// the wrong key, and a URL carries one.
type Check<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

const ok = <T>(value: T): Check<T> => ({ ok: true, value });
const bad = (reason: string): Check<never> => ({ ok: false, reason });

function decodes(part: string): boolean {
  try {
    decodeURIComponent(part);
    return true;
  } catch {
    return false;
  }
}

// Only plain parameter names are repeated back; anything else might be part of a secret.
function describeKeys(search: string): string {
  const keys = [...new URLSearchParams(search).keys()].map((key) =>
    /^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(key) ? key : 'an unnamed parameter',
  );
  return [...new Set(keys)].join(', ');
}

function checkUrl(raw: string | undefined): Check<string> {
  if (raw === undefined || raw.trim() === '') return bad('is missing');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return bad('is not a valid URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    return bad('must start with postgres:// or postgresql://');
  }
  if (url.hostname === '') return bad('has no host');
  if (url.port !== '' && (Number(url.port) < 1 || Number(url.port) > 65535)) {
    return bad('has a port outside 1 to 65535');
  }
  if (url.username === '') return bad('has no user');
  if (!decodes(url.username) || !decodes(url.password)) {
    return bad('has a broken percent escape in its user or password');
  }
  // DREFYN_DATABASE_SSL is the one place TLS is set, and options=-c would set session
  // settings for the role, which only migrations and the bootstrap decide.
  if (url.search !== '') {
    return bad(`must not carry query parameters (found ${describeKeys(url.search)})`);
  }
  if (url.hash !== '') return bad('must not carry a fragment');
  const database = url.pathname.replace(/^\//, '');
  if (database === '') return bad('has no database name');
  if (database.includes('/') || !decodes(database)) return bad('has an invalid database name');
  return ok(raw);
}

function checkPositiveInteger(raw: string | undefined, fallback: number): Check<number> {
  if (raw === undefined) return ok(fallback);
  // Zero is refused on purpose: pg reads a zero wait as forever and Postgres reads a zero
  // statement timeout as none, which turns a bounded failure into a hang.
  if (!/^[1-9][0-9]*$/.test(raw)) return bad('must be a whole number above zero');
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return bad('is too large');
  return ok(value);
}

function checkSsl(raw: string | undefined): Check<SslMode> {
  if (raw === undefined) return ok('verify-full');
  const mode = SSL_MODES.find((m) => m === raw);
  return mode === undefined ? bad(`must be one of ${SSL_MODES.join(', ')}`) : ok(mode);
}

class Collector {
  private readonly problems: string[] = [];

  take<T>(key: string, check: Check<T>, fallback: T): T {
    if (check.ok) return check.value;
    this.problems.push(`${key} ${check.reason}`);
    return fallback;
  }

  throwIfAny(): void {
    if (this.problems.length > 0) {
      throw new DbError(
        'DB_CONFIG_INVALID',
        `invalid database config: ${this.problems.join('; ')}`,
      );
    }
  }
}

// Reads DREFYN_DATABASE_URL and the pool, timeout and SSL keys. Throws DbError
// DB_CONFIG_INVALID naming the key; the message never carries a password or the URL.
export function parseDatabaseConfig(env: Env): DatabaseConfig {
  const c = new Collector();
  const config: DatabaseConfig = {
    url: c.take('DREFYN_DATABASE_URL', checkUrl(env['DREFYN_DATABASE_URL']), ''),
    poolMax: c.take(
      'DREFYN_DATABASE_POOL_MAX',
      checkPositiveInteger(env['DREFYN_DATABASE_POOL_MAX'], 10),
      0,
    ),
    poolWaitMs: c.take(
      'DREFYN_DATABASE_POOL_WAIT_MS',
      checkPositiveInteger(env['DREFYN_DATABASE_POOL_WAIT_MS'], 2000),
      0,
    ),
    statementTimeoutMs: c.take(
      'DREFYN_DATABASE_STATEMENT_TIMEOUT_MS',
      checkPositiveInteger(env['DREFYN_DATABASE_STATEMENT_TIMEOUT_MS'], 5000),
      0,
    ),
    ssl: c.take('DREFYN_DATABASE_SSL', checkSsl(env['DREFYN_DATABASE_SSL']), 'verify-full'),
  };
  c.throwIfAny();
  return config;
}

// Reads DREFYN_MIGRATION_DATABASE_URL and DREFYN_DATABASE_SSL only. It never falls back to
// the application URL: the migration role and the application role are different people.
export function parseMigrationConfig(env: Env): MigrationConfig {
  const c = new Collector();
  const config: MigrationConfig = {
    url: c.take(
      'DREFYN_MIGRATION_DATABASE_URL',
      checkUrl(env['DREFYN_MIGRATION_DATABASE_URL']),
      '',
    ),
    ssl: c.take('DREFYN_DATABASE_SSL', checkSsl(env['DREFYN_DATABASE_SSL']), 'verify-full'),
  };
  c.throwIfAny();
  return config;
}

// Reads DREFYN_PUBLIC_READER_DATABASE_URL with the same pool and SSL keys as the app pool and
// a 2000 ms statement timeout. It never falls back to DREFYN_DATABASE_URL: a missing reader
// URL must not become a reader pool with the app role's grants on drafts.
export function parsePublishedReaderConfig(env: Env): DatabaseConfig {
  const c = new Collector();
  const config: DatabaseConfig = {
    url: c.take(
      'DREFYN_PUBLIC_READER_DATABASE_URL',
      checkUrl(env['DREFYN_PUBLIC_READER_DATABASE_URL']),
      '',
    ),
    poolMax: c.take(
      'DREFYN_DATABASE_POOL_MAX',
      checkPositiveInteger(env['DREFYN_DATABASE_POOL_MAX'], 10),
      0,
    ),
    poolWaitMs: c.take(
      'DREFYN_DATABASE_POOL_WAIT_MS',
      checkPositiveInteger(env['DREFYN_DATABASE_POOL_WAIT_MS'], 2000),
      0,
    ),
    statementTimeoutMs: READER_STATEMENT_TIMEOUT_MS,
    ssl: c.take('DREFYN_DATABASE_SSL', checkSsl(env['DREFYN_DATABASE_SSL']), 'verify-full'),
  };
  c.throwIfAny();
  return config;
}

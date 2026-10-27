import { DbError, type DbErrorCode } from './errors.ts';

const TIMEOUTS = new Set(['57014', '55P03', '25P03']);
// Shutdown, startup, crash recovery and too many connections heal on their own; a retry
// with backoff can help.
const UNAVAILABLE = new Set(['57P01', '57P02', '57P03', '53300']);
// A wrong password, a refused login or a missing database never heals by retrying.
const CONFIG = new Set(['28P01', '28000', '3D000']);
const SOCKET = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);
// What pg and pg-pool say when the pool wait runs out or a connection drops.
const DRIVER_UNAVAILABLE = [
  /^timeout exceeded when trying to connect$/,
  /^Connection terminated/,
  /^Client has encountered a connection error and is not queryable$/,
];

// The server's routine for a WITH CHECK failure. The message is translated by lc_messages
// on a self host, so it is only a fallback for a driver that gives no routine.
const POLICY_ROUTINE = 'ExecWithCheckOptions';
const POLICY_TEXT = 'row-level security policy';

const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

function field(error: Error, name: string): string | undefined {
  const value: unknown = Reflect.get(error, name);
  return typeof value === 'string' ? value : undefined;
}

function policyViolation(error: Error): boolean {
  const routine = field(error, 'routine');
  if (routine !== undefined) return routine === POLICY_ROUTINE;
  return error.message.includes(POLICY_TEXT);
}

function codeFor(error: Error, sqlState: string | undefined): DbErrorCode | undefined {
  if (sqlState === undefined) {
    return DRIVER_UNAVAILABLE.some((p) => p.test(error.message)) ? 'DB_UNAVAILABLE' : undefined;
  }
  if (sqlState === '42501') return policyViolation(error) ? 'DB_RLS_VIOLATION' : undefined;
  if (sqlState === '23505') return 'DB_UNIQUE_VIOLATION';
  if (TIMEOUTS.has(sqlState)) return 'DB_TIMEOUT';
  if (UNAVAILABLE.has(sqlState) || sqlState.startsWith('08') || SOCKET.has(sqlState)) {
    return 'DB_UNAVAILABLE';
  }
  if (CONFIG.has(sqlState)) return 'DB_CONFIG_INVALID';
  return undefined;
}

// Fixed text plus names Postgres chose, never the server's message, detail, hint or the
// query values, any of which can carry tenant data. No cause either, for the same reason.
function messageFor(code: DbErrorCode, error: Error, sqlState: string, configKey: string): string {
  switch (code) {
    case 'DB_RLS_VIOLATION':
      return 'a row level security policy refused the write (42501)';
    case 'DB_UNIQUE_VIOLATION': {
      const constraint = field(error, 'constraint');
      return constraint !== undefined && PLAIN_NAME.test(constraint)
        ? `unique constraint ${constraint} refused the write (23505)`
        : 'a unique constraint refused the write (23505)';
    }
    case 'DB_TIMEOUT':
      return `the statement ran past its timeout (${sqlState})`;
    case 'DB_CONFIG_INVALID':
      return `the database refused the login from ${configKey} (${sqlState}); check the role, password and database name`;
    default:
      return sqlState === ''
        ? 'the database is unavailable or the pool stayed busy past its wait'
        : `the database is unavailable (${sqlState})`;
  }
}

// Maps a driver error to a DbError where a stable code exists; anything else comes back as
// it was given. configKey names the URL key in a login failure.
export function toDbError(error: unknown, configKey = 'the database URL'): unknown {
  if (error instanceof DbError || !(error instanceof Error)) return error;
  const sqlState = field(error, 'code');
  const code = codeFor(error, sqlState);
  if (code === undefined) return error;
  return new DbError(code, messageFor(code, error, sqlState ?? '', configKey));
}

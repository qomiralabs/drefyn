import {
  runAloneOnApiKeyLimiter,
  runAloneOnAuth,
  type AuthDatabase,
  type Database,
} from './database.ts';
import { DbError } from './errors.ts';

// Fixed window counters. One upsert per window takes a row lock, so parallel reservations on
// one key queue on that row and each sees its own count: no burst gets past the limit.
//
// Each reservation runs and commits in a transaction of its own, before the caller's work.
// Inside the caller's transaction, a failed attempt thrown from the work would roll its own
// count back, and the row lock would be held for the whole work, queueing every other
// request on that key behind it.
//
// The upsert and its commit go to the server in one message, so the row lock is held only
// while the server runs it. A key under attack is exactly when hundreds of reservations
// queue on one row; a pause in this process between the upsert and a separate commit would
// make all of them wait, then time out.

export interface WindowCount {
  readonly windowSeconds: number;
  // Reservations in this window so far, this one included.
  readonly count: number;
  // Seconds until the window ends, by the database clock, at least 1.
  readonly retryAfterSeconds: number;
}

export interface RateWindowRequest {
  readonly bucket: string;
  readonly keyHmac: Uint8Array;
  readonly windowSeconds: readonly number[];
}

export interface ApiKeyFailureRequest {
  readonly keyHmac: Uint8Array;
  readonly windowSeconds: readonly number[];
}

const BUCKET = /^[a-z][a-z0-9_]{0,62}$/;
const KEY_BYTES = 32;
const MAX_WINDOWS = 3;
// The longest window the auth config accepts.
const MAX_WINDOW_SECONDS = 7 * 86_400;
// The counter stops here rather than overflowing integer; any count this high is refused.
const COUNT_CAP = 2_147_483_647;

function invalid(reason: string): DbError {
  return new DbError('DB_CONFIG_INVALID', `rate window request ${reason}`);
}

function checkWindows(windows: readonly number[]): number[] {
  // One read of the caller's list. Checking it and then reading it again would let a list
  // that changes between reads write something the checks never saw.
  const list = [...windows];
  if (list.length === 0 || list.length > MAX_WINDOWS) {
    throw invalid(`needs 1 to ${String(MAX_WINDOWS)} windows`);
  }
  for (const w of list) {
    if (!Number.isSafeInteger(w) || w < 1 || w > MAX_WINDOW_SECONDS) {
      throw invalid(`windows must be whole seconds from 1 to ${String(MAX_WINDOW_SECONDS)}`);
    }
  }
  // Two equal windows would be one row twice in one upsert, which Postgres refuses.
  if (new Set(list).size !== list.length) throw invalid('lists a window twice');
  return list;
}

// The statement goes over the simple protocol, which has no parameters, so values are
// written into the text. Only three kinds ever are, each checked first: the 32 byte key as
// hex, whole seconds, and a bucket of lower case letters, digits and underscores.
function keyLiteral(key: Uint8Array): string {
  if (key.length !== KEY_BYTES) throw invalid(`key must be ${String(KEY_BYTES)} bytes`);
  return `decode('${Buffer.from(key).toString('hex')}', 'hex')`;
}

function bucketLiteral(bucket: unknown): string {
  // RegExp.test coerces, so ['a'] would pass the pattern without being a string.
  if (typeof bucket !== 'string' || !BUCKET.test(bucket)) {
    throw invalid('has a bucket that is not a short identifier');
  }
  return `'${bucket}'`;
}

interface Row {
  window_seconds: number;
  count: number;
  retry_after: number;
}

const isPositive = (value: number) => Number.isSafeInteger(value) && value > 0;

// In the order the windows were asked for, one for each. A window with no row would have its
// limit skipped, so an answer that does not name each window exactly once is a failure.
function toCounts(rows: readonly Row[], order: readonly number[]): WindowCount[] {
  const incomplete = () =>
    new DbError('DB_CONFIG_INVALID', 'a rate window reservation did not count each window once');
  if (rows.length !== order.length) throw incomplete();
  return order.map((windowSeconds) => {
    const [row, repeat] = rows.filter((r) => r.window_seconds === windowSeconds);
    if (row === undefined || repeat !== undefined) throw incomplete();
    // The statement cannot return these, so one here means the numbers cannot be trusted.
    if (!isPositive(row.count) || !isPositive(row.retry_after)) {
      throw new DbError('DB_CONFIG_INVALID', 'a rate window reservation returned a bad number');
    }
    return { windowSeconds, count: row.count, retryAfterSeconds: row.retry_after };
  });
}

// Windows start on multiples of their length since the epoch, by the database clock, so
// every app host agrees on them whatever its own clock says.
const windows = (seconds: readonly number[]) => `
  select w as seconds,
         to_timestamp(floor(extract(epoch from now()) / w) * w) as start
    from unnest(array[${seconds.map(String).join(', ')}]::int[]) as w`;

const returned = `
  returning extract(epoch from (window_end - window_start))::int as window_seconds, count,
            greatest(1, ceil(extract(epoch from (window_end - now()))))::int as retry_after`;

// The statement is one round trip; a stalled row should fail fast rather than hold a
// connection of the small auth pool.
const RESERVE_TIMEOUT_MS = 1000;

// Counts one sign in attempt against each window of a bucket, committed before it returns.
export async function reserveAuthRateWindows(
  db: AuthDatabase,
  request: RateWindowRequest,
): Promise<readonly WindowCount[]> {
  const bucket = bucketLiteral(request.bucket);
  const key = keyLiteral(request.keyHmac);
  const seconds = checkWindows(request.windowSeconds);
  const statement = `
    with w as (${windows(seconds)})
    insert into app.auth_rate_limits as t (bucket, key_hmac, window_start, window_end, count)
    select ${bucket}, ${key}, w.start, w.start + make_interval(secs => w.seconds), 1
      from w
    on conflict (bucket, key_hmac, window_start, window_end)
    do update set count = least(t.count + 1, ${String(COUNT_CAP)})
    ${returned}`;
  const rows = await runAloneOnAuth<Row>(db, statement, { timeoutMs: RESERVE_TIMEOUT_MS });
  return toCounts(rows, seconds);
}

// Counts one failed API key check against each window, committed before it returns.
export async function reserveApiKeyFailureWindows(
  db: Database,
  request: ApiKeyFailureRequest,
): Promise<readonly WindowCount[]> {
  const key = keyLiteral(request.keyHmac);
  const seconds = checkWindows(request.windowSeconds);
  const statement = `
    with w as (${windows(seconds)})
    insert into app.api_key_failures as t (key_hmac, window_start, window_end, count)
    select ${key}, w.start, w.start + make_interval(secs => w.seconds), 1
      from w
    on conflict (key_hmac, window_start, window_end)
    do update set count = least(t.count + 1, ${String(COUNT_CAP)})
    ${returned}`;
  const rows = await runAloneOnApiKeyLimiter<Row>(db, statement, {
    timeoutMs: RESERVE_TIMEOUT_MS,
  });
  return toCounts(rows, seconds);
}

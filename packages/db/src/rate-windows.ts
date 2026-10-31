import { sql } from 'kysely';
import { withApiKeyLimiter, withAuth, type AuthDatabase, type Database } from './database.ts';
import { DbError } from './errors.ts';

// Fixed window counters. One upsert per window takes a row lock, so parallel reservations on
// one key queue on that row and each sees its own count: no burst gets past the limit.
//
// Each reservation runs and commits in a transaction of its own, before the caller's work.
// Inside the caller's transaction, a failed attempt thrown from the work would roll its own
// count back, and the row lock would be held for the whole work, queueing every other
// request on that key behind it.

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
  if (windows.length === 0 || windows.length > MAX_WINDOWS) {
    throw invalid(`needs 1 to ${String(MAX_WINDOWS)} windows`);
  }
  for (const w of windows) {
    if (!Number.isSafeInteger(w) || w < 1 || w > MAX_WINDOW_SECONDS) {
      throw invalid(`windows must be whole seconds from 1 to ${String(MAX_WINDOW_SECONDS)}`);
    }
  }
  // Two equal windows would be one row twice in one upsert, which Postgres refuses.
  if (new Set(windows).size !== windows.length) throw invalid('lists a window twice');
  return [...windows];
}

function checkKey(key: Uint8Array): Buffer {
  if (key.length !== KEY_BYTES) throw invalid(`key must be ${String(KEY_BYTES)} bytes`);
  return Buffer.from(key);
}

interface Row {
  window_seconds: number;
  count: number;
  retry_after: number;
}

// In the order the windows were asked for.
const toCounts = (rows: readonly Row[], order: readonly number[]): WindowCount[] =>
  rows
    .map((row) => ({
      windowSeconds: row.window_seconds,
      count: row.count,
      retryAfterSeconds: row.retry_after,
    }))
    .sort((a, b) => order.indexOf(a.windowSeconds) - order.indexOf(b.windowSeconds));

// Windows start on multiples of their length since the epoch, by the database clock, so
// every app host agrees on them whatever its own clock says.
const windows = (seconds: readonly number[]) => sql`
  select w as seconds,
         to_timestamp(floor(extract(epoch from now()) / w) * w) as start
    from unnest(${seconds}::int[]) as w`;

const returned = sql`
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
  if (!BUCKET.test(request.bucket)) throw invalid('has a bucket that is not a short identifier');
  const key = checkKey(request.keyHmac);
  const seconds = checkWindows(request.windowSeconds);
  const query = sql<Row>`
    with w as (${windows(seconds)})
    insert into app.auth_rate_limits as t (bucket, key_hmac, window_start, window_end, count)
    select ${request.bucket}, ${key}, w.start, w.start + make_interval(secs => w.seconds), 1
      from w
    on conflict (bucket, key_hmac, window_start, window_end)
    do update set count = least(t.count + 1, ${COUNT_CAP})
    ${returned}`;
  const result = await withAuth(db, (tx) => query.execute(tx), { timeoutMs: RESERVE_TIMEOUT_MS });
  return toCounts(result.rows, seconds);
}

// Counts one failed API key check against each window, committed before it returns.
export async function reserveApiKeyFailureWindows(
  db: Database,
  request: ApiKeyFailureRequest,
): Promise<readonly WindowCount[]> {
  const key = checkKey(request.keyHmac);
  const seconds = checkWindows(request.windowSeconds);
  const query = sql<Row>`
    with w as (${windows(seconds)})
    insert into app.api_key_failures as t (key_hmac, window_start, window_end, count)
    select ${key}, w.start, w.start + make_interval(secs => w.seconds), 1
      from w
    on conflict (key_hmac, window_start, window_end)
    do update set count = least(t.count + 1, ${COUNT_CAP})
    ${returned}`;
  const result = await withApiKeyLimiter(db, (tx) => query.execute(tx), {
    timeoutMs: RESERVE_TIMEOUT_MS,
  });
  return toCounts(result.rows, seconds);
}

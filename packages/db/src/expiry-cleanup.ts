import { sql, type Transaction } from 'kysely';
import type { ApiKeyLimiterSchema, AuthSchema } from './contexts.ts';
import type { DbLogger } from './database.ts';
import { DbError } from './errors.ts';
import type { ColumnType } from './schema.generated.ts';

// Deletes rows a fixed time after a timestamp column passes, by the database clock. The rule
// list is open: a later table registers its own rule beside the shipped ones.

type SelectOf<C> = C extends ColumnType<infer S, unknown, unknown> ? S : C;

// Columns of a table that hold a time, nullable or not.
type TimeColumn<T> = {
  [K in keyof T]: [SelectOf<T[K]>] extends [Date | null] ? K : never;
}[keyof T] &
  string;

export type ExpiryRule<S> = {
  [T in keyof S & string]: {
    readonly table: T;
    readonly column: TimeColumn<S[T]>;
    // Rows go once the column is this many seconds in the past.
    readonly afterSeconds: number;
  };
}[keyof S & string];

// Deleted rows per table, in the order the rules first name each table.
export type ExpiryCounts = Readonly<Record<string, number>>;

const DAY = 86_400;

export const AUTH_EXPIRY_RULES: readonly ExpiryRule<AuthSchema>[] = Object.freeze([
  { table: 'auth_rate_limits', column: 'window_end', afterSeconds: 0 },
  // A day past expiry, so support can still see a failed sign in the person just reported.
  { table: 'email_challenges', column: 'expires_at', afterSeconds: DAY },
  { table: 'oauth_states', column: 'expires_at', afterSeconds: DAY },
]);

export const API_KEY_EXPIRY_RULES: readonly ExpiryRule<ApiKeyLimiterSchema>[] = Object.freeze([
  { table: 'api_key_failures', column: 'window_end', afterSeconds: 0 },
]);

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
// The longest retention any rule needs: device cookies live at most 400 days.
const MAX_AFTER_SECONDS = 400 * DAY;
const DEFAULT_BATCH = 5_000;
const MAX_BATCH = 50_000;
const MIN_INTERVAL_MS = 60_000;

function invalid(reason: string): DbError {
  return new DbError('DB_CONFIG_INVALID', `expiry rule ${reason}`);
}

function checkRules<S>(rules: readonly ExpiryRule<S>[]): void {
  if (rules.length === 0) throw invalid('list is empty');
  const seen = new Set<string>();
  for (const { table, column, afterSeconds } of rules) {
    // Names go into the SQL as identifiers, so they are held to a plain shape first.
    if (!IDENTIFIER.test(table) || !IDENTIFIER.test(column)) {
      throw invalid('names a table or column that is not a plain identifier');
    }
    if (
      !Number.isSafeInteger(afterSeconds) ||
      afterSeconds < 0 ||
      afterSeconds > MAX_AFTER_SECONDS
    ) {
      throw invalid(`age must be whole seconds from 0 to ${String(MAX_AFTER_SECONDS)}`);
    }
    const id = `${table}.${column}`;
    if (seen.has(id)) throw invalid(`for ${id} is listed twice`);
    seen.add(id);
  }
}

function checkBatch(batchSize: number): number {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH) {
    throw invalid(`batch must be from 1 to ${String(MAX_BATCH)} rows`);
  }
  return batchSize;
}

export interface DeleteExpiredOptions {
  // Rows per table per run, so a backlog never holds one statement past its timeout.
  readonly batchSize?: number;
}

// Runs inside the caller's transaction, one bounded delete per rule.
export async function deleteExpired<S>(
  tx: Transaction<S>,
  rules: readonly ExpiryRule<S>[],
  options: DeleteExpiredOptions = {},
): Promise<ExpiryCounts> {
  checkRules(rules);
  const batch = checkBatch(options.batchSize ?? DEFAULT_BATCH);
  const perRule: { readonly table: string; readonly deleted: number }[] = [];
  for (const { table, column, afterSeconds } of rules) {
    const target = sql.table(`app.${table}`);
    const at = sql.ref(column);
    const result = await sql<{ deleted: number }>`
      with gone as (
        delete from ${target}
         where ctid in (select ctid from ${target}
                         where ${at} < now() - make_interval(secs => ${afterSeconds})
                         limit ${batch})
        returning 1)
      select count(*)::int as deleted from gone`.execute(tx);
    perRule.push({ table, deleted: result.rows.reduce((sum, row) => sum + row.deleted, 0) });
  }
  // Two rules on one table add up under that table's name.
  const tables = [...new Set(rules.map((rule) => rule.table))];
  return Object.fromEntries(
    tables.map((table) => [
      table,
      perRule.filter((rule) => rule.table === table).reduce((sum, rule) => sum + rule.deleted, 0),
    ]),
  );
}

export interface ExpiryCleanupOptions<S> {
  readonly rules: readonly ExpiryRule<S>[];
  // Opens the transaction the deletes run in: withAuth or withApiKeyLimiter.
  readonly transact: (work: (tx: Transaction<S>) => Promise<ExpiryCounts>) => Promise<ExpiryCounts>;
  readonly batchSize?: number;
  readonly now?: () => number;
  // For the deletion counts metric, once per table per run, zero included.
  readonly onDeleted?: (table: string, count: number) => void;
  readonly logger?: DbLogger;
}

export interface ExpiryCleanup<S> {
  readonly rules: readonly ExpiryRule<S>[];
  // Runs when a minute has passed since the last start and nothing is running. Never
  // rejects: cleanup must not fail the request that triggered it.
  maybeRun(): Promise<ExpiryCounts | null>;
}

export function createExpiryCleanup<S>(options: ExpiryCleanupOptions<S>): ExpiryCleanup<S> {
  const rules = Object.freeze([...options.rules]);
  checkRules(rules);
  const batchSize = checkBatch(options.batchSize ?? DEFAULT_BATCH);
  const now = options.now ?? Date.now;
  let lastStart: number | null = null;
  let running = false;

  const report = (counts: ExpiryCounts) => {
    for (const [table, count] of Object.entries(counts)) {
      try {
        options.onDeleted?.(table, count);
      } catch {
        // Metrics are best effort.
      }
    }
  };

  return Object.freeze({
    rules,
    async maybeRun(): Promise<ExpiryCounts | null> {
      const started = now();
      if (running || (lastStart !== null && started - lastStart < MIN_INTERVAL_MS)) return null;
      // Set before the work, so a failing database is tried once a minute, not per request.
      lastStart = started;
      running = true;
      try {
        const counts = await options.transact((tx) => deleteExpired(tx, rules, { batchSize }));
        report(counts);
        return counts;
      } catch (error) {
        try {
          // Table names and the fixed DbError code only: an error's text can carry values from
          // the statement. The code tells a timeout from an outage.
          options.logger?.warn('db_expiry_cleanup_failed', {
            tables: [...new Set(rules.map((r) => r.table))].join(','),
            code: error instanceof DbError ? error.code : 'unknown',
          });
        } catch {
          // Logging is best effort.
        }
        return null;
      } finally {
        running = false;
      }
    },
  });
}

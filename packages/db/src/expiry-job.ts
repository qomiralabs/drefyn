import { sql } from 'kysely';
import { withAuth, type AuthDatabase } from './database.ts';
import { DbError } from './errors.ts';
import {
  AUTH_EXPIRY_RULES,
  deleteExpiredRows,
  type ExpiryCounts,
  type OrganizationDeletion,
} from './expiry-cleanup.ts';

// The expiry cleanup on a clock. Every server runs the schedule; the row in scheduled_jobs
// picks which one does the work, so nothing outside Postgres has to be set up or paid for.

const JOB = 'auth_expiry';
const RUN_EVERY_SECONDS = 3600;
// Each statement deletes one bounded batch, so the longest the auth pool allows is enough.
const STATEMENT_TIMEOUT_MS = 10_000;

const MINUTE_MS = 60_000;
// Checking costs one primary key lookup, so servers can ask well inside the run interval.
const TICK_MS = 15 * MINUTE_MS;

export type ExpiryJobResult =
  | { readonly ran: false }
  | {
      readonly ran: true;
      readonly counts: ExpiryCounts;
      readonly organizations: readonly OrganizationDeletion[];
      readonly backlog: boolean;
    };

export interface ExpiryJobOptions {
  readonly batchSize?: number;
}

// One attempt. The turn and the deletes share a transaction: a failure or a killed process
// undoes both and leaves the job due, so no lease can be left behind to wait out. skip locked
// sends a server away at once while another is mid run, and a row it read as due is checked
// again once locked, so a run that just finished is not repeated.
export async function runExpiryJob(
  db: AuthDatabase,
  options: ExpiryJobOptions = {},
): Promise<ExpiryJobResult> {
  return withAuth(
    db,
    async (tx): Promise<ExpiryJobResult> => {
      const turn = await sql`
        with due as (
          select name from app.scheduled_jobs
           where name = ${JOB} and next_run_at <= now()
             for update skip locked)
        update app.scheduled_jobs j
           set last_run_at = now(),
               next_run_at = now() + make_interval(secs => ${RUN_EVERY_SECONDS})
          from due
         where j.name = due.name
        returning j.name`.execute(tx);
      if (turn.rows.length === 0) return { ran: false };
      const result = await deleteExpiredRows(tx, AUTH_EXPIRY_RULES, options);
      if (result.backlog) {
        await sql`update app.scheduled_jobs set next_run_at = now() where name = ${JOB}`.execute(
          tx,
        );
      }
      return { ran: true, ...result };
    },
    { timeoutMs: STATEMENT_TIMEOUT_MS },
  );
}

export type ExpiryRun =
  | {
      readonly outcome: 'done';
      readonly counts: ExpiryCounts;
      readonly organizations: readonly OrganizationDeletion[];
    }
  // The fixed DbError code only: an error's text can carry values from the statement.
  | { readonly outcome: 'failed'; readonly code: string; readonly attempt: number };

export interface ExpiryScheduleOptions {
  readonly run: () => Promise<ExpiryJobResult>;
  // Once per run this server did or failed; a turn another server held reports nothing.
  readonly onRun: (run: ExpiryRun) => void;
  // From 0 to 1. Tests pin it.
  readonly random?: () => number;
  // Returns the cancel. Tests fire these by hand.
  readonly setTimer?: (work: () => void, ms: number) => () => void;
}

export interface ExpirySchedule {
  // A run in flight is left to finish or roll back with the process.
  stop(): void;
}

function realTimer(work: () => void, ms: number): () => void {
  const timer = setTimeout(work, ms);
  // Never the thing that keeps a stopping server alive.
  timer.unref();
  return () => {
    clearTimeout(timer);
  };
}

// Jitter keeps servers that failed together from retrying together. Retries never give up,
// since the rows must go eventually, but past the cap they come no faster than the tick.
export function retryDelayMs(attempt: number, random: number): number {
  const ceiling = Math.min(TICK_MS, MINUTE_MS * 2 ** Math.min(attempt - 1, 16));
  return Math.round(ceiling * (0.5 + random / 2));
}

export function startExpirySchedule(options: ExpiryScheduleOptions): ExpirySchedule {
  const { run, onRun, random = Math.random, setTimer = realTimer } = options;
  let cancel: (() => void) | undefined;
  let stopped = false;
  let failures = 0;

  const report = (entry: ExpiryRun) => {
    try {
      onRun(entry);
    } catch {
      // Reporting is best effort; the schedule outlives it.
    }
  };

  const wait = (ms: number) => {
    if (!stopped) cancel = setTimer(attempt, ms);
  };

  const around = (ms: number) => Math.round(ms * (0.75 + random() / 2));

  function attempt(): void {
    run().then(
      (result) => {
        failures = 0;
        if (!result.ran) {
          wait(around(TICK_MS));
          return;
        }
        report({ outcome: 'done', counts: result.counts, organizations: result.organizations });
        wait(around(result.backlog ? MINUTE_MS : TICK_MS));
      },
      (error: unknown) => {
        failures += 1;
        const code = error instanceof DbError ? error.code : 'unknown';
        report({ outcome: 'failed', code, attempt: failures });
        wait(retryDelayMs(failures, random()));
      },
    );
  }

  // Soon after start, so a server that restarts often still gets a turn, but spread out so a
  // deploy does not send every server at the row in the same instant.
  wait(Math.floor(random() * MINUTE_MS));
  return Object.freeze({
    stop() {
      stopped = true;
      cancel?.();
    },
  });
}

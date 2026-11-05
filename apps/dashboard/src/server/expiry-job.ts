import {
  createAuthDatabase,
  parseAuthDatabaseConfig,
  runExpiryJob,
  startExpirySchedule,
  type AuthDatabase,
  type DatabaseConfig,
  type ExpiryJobResult,
  type ExpiryRun,
  type ExpirySchedule,
} from '@drefyn/db';
import { logInfo, logWarn } from './log.ts';

type Env = Readonly<Record<string, string | undefined>>;

interface RunDeps {
  readonly open: (config: DatabaseConfig) => Promise<AuthDatabase>;
  readonly job: (db: AuthDatabase) => Promise<ExpiryJobResult>;
}

// A pool of its own, so a long delete never takes a connection from a sign in. Opened on the
// first run and not at start: Postgres being down when the server boots is one more failed
// run to retry, never a reason for the server to stay down.
export function openExpiryRun(
  env: Env,
  deps: RunDeps = { open: createAuthDatabase, job: runExpiryJob },
): () => Promise<ExpiryJobResult> {
  let db: AuthDatabase | undefined;
  return async () => {
    db ??= await deps.open({ ...parseAuthDatabaseConfig(env), poolMax: 1 });
    return deps.job(db);
  };
}

// Lines any log collector can count, since the dashboard has no metrics endpoint to scrape
// and a new public route is a poor trade for one counter.
export function reportExpiryRun(run: ExpiryRun): void {
  if (run.outcome === 'failed') {
    logWarn('dashboard.expiry_failed', { code: run.code, attempt: run.attempt });
  } else {
    logInfo('dashboard.expiry_done', { ...run.counts });
    for (const { organizationId, table, deleted } of run.organizations) {
      logInfo('dashboard.expiry_deleted', { organizationId, table, deleted });
    }
  }
  logInfo('dashboard.metric', { metric: 'expiry_job_runs_total', outcome: run.outcome, value: 1 });
}

// Not behind dashboard.shell: a key's 90 days run whether or not the pages are on, and an
// empty run costs one lookup.
export function startExpiryJob(env: Env): ExpirySchedule {
  return startExpirySchedule({ run: openExpiryRun(env), onRun: reportExpiryRun });
}

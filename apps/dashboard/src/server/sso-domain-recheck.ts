import {
  createNodeTxtResolver,
  createSsoDomainRecheck,
  parseAuthConfig,
  type SsoDomainRecheck,
  type SsoDomainRecheckSummary,
} from '@drefyn/auth';
import {
  createAuthDatabase,
  createDatabase,
  parseAuthDatabaseConfig,
  parseDatabaseConfig,
} from '@drefyn/db';
import { logEventSink } from './auth-events.ts';
import { authLogger } from './auth-logger.ts';
import { dashboardMail } from './auth-mailer.ts';
import { mailDeliveryEnabled, teamSsoFlag, teamSsoForServer } from './flags.ts';
import { logInfo, logWarn } from './log.ts';
import { mailableOrganizationName, organizationNames } from './organization-name.ts';

type Env = Readonly<Record<string, string | undefined>>;

// A domain is looked up at most once a day whatever the schedule, so an hourly tick only
// decides how soon after its day is up a domain is checked again.
export const RECHECK_EVERY_MS = 60 * 60 * 1000;
// Lookups per run, each under the DNS timeout, so one run has a known worst case. Domains
// left over wait for the next tick.
const MAX_PER_RUN = 500;

export interface RecheckScheduleOptions {
  // Read before every run; any failure is off.
  readonly enabled: () => Promise<boolean>;
  readonly run: () => Promise<SsoDomainRecheckSummary>;
  // From 0 to 1. Tests pin it.
  readonly random?: () => number;
  // Returns the cancel. Tests fire these by hand.
  readonly setTimer?: (work: () => void, ms: number) => () => void;
}

export interface RecheckSchedule {
  // A run in flight is left to finish; its rows are each updated on their own.
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

export function reportRecheck(summary: SsoDomainRecheckSummary): void {
  logInfo('dashboard.sso_recheck_done', {
    checked: summary.checked,
    confirmed: summary.confirmed,
    missed: summary.missed,
    unknown: summary.unknown,
    unverified: summary.unverified,
    skipped: summary.skipped,
    failed: summary.failed,
    more: summary.more,
  });
}

// The next tick is set only once a run has ended, so runs on one server never overlap. A
// failed run is retried on the next tick rather than sooner: a miss counts once a day at
// most, so retrying faster gains nothing and only adds load while something is down.
export function startSsoDomainRecheck(options: RecheckScheduleOptions): RecheckSchedule {
  const { enabled, run, random = Math.random, setTimer = realTimer } = options;
  let cancel: (() => void) | undefined;
  let stopped = false;

  const wait = (ms: number) => {
    if (!stopped) cancel = setTimer(tick, ms);
  };
  const around = (ms: number) => Math.round(ms * (0.75 + random() / 2));

  async function once(): Promise<void> {
    if (!(await enabled().catch(() => false))) return;
    try {
      reportRecheck(await run());
    } catch {
      // No detail: a database or DNS error can carry a host or a domain.
      logWarn('dashboard.sso_recheck_failed');
    }
  }

  function tick(): void {
    void once().then(() => {
      wait(around(RECHECK_EVERY_MS));
    });
  }

  // Spread over the first hour, so a deploy does not send every server at DNS at once.
  wait(Math.floor(random() * RECHECK_EVERY_MS));
  return Object.freeze({
    stop() {
      stopped = true;
      cancel?.();
    },
  });
}

// Built on the first run and not at start: Postgres being down when the server boots is one
// more failed run, never a reason for the server to stay down. A failed build is dropped, so
// the next tick builds again.
export function openSsoDomainRecheck(
  build: () => Promise<SsoDomainRecheck>,
): () => Promise<SsoDomainRecheckSummary> {
  let built: Promise<SsoDomainRecheck> | undefined;
  return async () => {
    built ??= build().catch((error: unknown) => {
      built = undefined;
      throw error;
    });
    return (await built).runOnce();
  };
}

// Pools of their own with one connection each, so a slow run never takes one from a request.
async function buildRecheck(env: Env): Promise<SsoDomainRecheck> {
  const config = parseAuthConfig(env);
  const db = await createDatabase({ ...parseDatabaseConfig(env), poolMax: 1 });
  const authDb = await createAuthDatabase({ ...parseAuthDatabaseConfig(env), poolMax: 1 });
  const mail = await dashboardMail({
    linkOrigin: new URL(config.appOrigin),
    organizationName: mailableOrganizationName(organizationNames(db)),
    enabled: mailDeliveryEnabled,
  });
  return createSsoDomainRecheck({
    db,
    authDb,
    keys: config.keys,
    resolver: createNodeTxtResolver({ timeoutMs: config.sso.dnsTimeoutMs }),
    flag: teamSsoFlag,
    logger: authLogger,
    mailer: mail.auth,
    events: logEventSink,
    maxPerRun: MAX_PER_RUN,
  });
}

// Every server runs it. Updates are conditional on the row as read, so two servers on the
// same domain cost one extra lookup, never a double strike.
export function startSsoDomainRecheckJob(env: Env): RecheckSchedule {
  return startSsoDomainRecheck({
    enabled: teamSsoForServer,
    run: openSsoDomainRecheck(() => buildRecheck(env)),
  });
}

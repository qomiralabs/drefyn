import type pg from 'pg';
import { parseMigrationConfig } from './config.ts';
import { createClient } from './pg-session.ts';

export const MAINTAIN_USAGE = 'usage: drefyn maintain filter-rows [--after-import]';

// A freshly built key is about as large as the heap (345 MB against 365 MB), and an import's loose
// key was 608 MB, so the ratio stands in for a bloat figure. pgstatindex would be exact, and needs
// an extension, and pg_stats hides tables under forced row level security from every app role.
export const REINDEX_BLOAT_PERCENT = 30;
export const OLDEST_TRANSACTION_ALERT_SECONDS = 300;
// Past this, lists had drifted to a p95 of 135 to 162 ms, with heap fetches on half the type.
export const DEAD_TUPLES_ALERT = 20_000;

// Vacuum and a rebuild are table work, and the table is shared by every tenant. A rebuild took
// 3.4 s here but scales with the table, so the bound leaves room for a large platform.
const WORK_TIMEOUT_MS = 30 * 60_000;
// Any fixed number: two runs must not rebuild one index at once.
const LOCK_KEY = 1_795_000_000;
const INDEX = 'app.node_filter_rows_pkey';
// What a failed concurrent rebuild leaves behind, which would slow every write.
const LEFTOVER = `${INDEX}_ccnew`;
const TABLES = ['app.nodes', 'app.node_filter_rows'];

export interface FilterRowFacts {
  readonly deadTuples: number;
  readonly oldestTransactionSeconds: number;
  readonly heapBytes: number;
  readonly indexBytes: number;
}

export function bloatPercent({ heapBytes, indexBytes }: FilterRowFacts): number {
  if (indexBytes <= 0 || indexBytes <= heapBytes) return 0;
  return Math.round((100 * (indexBytes - heapBytes)) / indexBytes);
}

export function filterRowAlerts(facts: FilterRowFacts): readonly string[] {
  const alerts: string[] = [];
  if (facts.oldestTransactionSeconds > OLDEST_TRANSACTION_ALERT_SECONDS) {
    alerts.push('engine.filter_rows.old_transaction');
  }
  if (facts.deadTuples > DEAD_TUPLES_ALERT) alerts.push('engine.filter_rows.dead_tuples');
  return alerts;
}

export interface MaintenancePlan {
  readonly vacuum: boolean;
  readonly reindex: boolean;
}

export function planMaintenance(facts: FilterRowFacts, afterImport: boolean): MaintenancePlan {
  return {
    // analyze alone made plans worse, as the planner trusted index only scans with no visibility
    // map behind them.
    vacuum: afterImport,
    reindex: afterImport || bloatPercent(facts) > REINDEX_BLOAT_PERCENT,
  };
}

export interface FilterMaintenanceSession {
  query(text: string): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}

const FACTS = `
select (select coalesce(n_dead_tup, 0) from pg_stat_all_tables
         where schemaname = 'app' and relname = 'node_filter_rows') as dead_tuples,
       (select coalesce(extract(epoch from now() - min(xact_start)), 0)::bigint
          from pg_stat_activity
         where datname = current_database() and pid <> pg_backend_pid()
           and backend_type = 'client backend') as oldest_seconds,
       pg_relation_size('app.node_filter_rows') as heap_bytes,
       pg_relation_size('${INDEX}') as index_bytes`;

async function readFacts(session: FilterMaintenanceSession): Promise<FilterRowFacts> {
  const { rows } = await session.query(FACTS);
  const row = rows[0] ?? {};
  return {
    deadTuples: Number(row['dead_tuples'] ?? 0),
    oldestTransactionSeconds: Number(row['oldest_seconds'] ?? 0),
    heapBytes: Number(row['heap_bytes'] ?? 0),
    indexBytes: Number(row['index_bytes'] ?? 0),
  };
}

async function rebuild(session: FilterMaintenanceSession): Promise<void> {
  try {
    await session.query(`reindex index concurrently ${INDEX}`);
  } catch (error) {
    await session.query(`drop index concurrently if exists ${LEFTOVER}`);
    throw error;
  }
}

export interface MaintenanceReport extends MaintenancePlan {
  readonly event: 'engine.filter_rows.maintenance';
  readonly ran: boolean;
  readonly dead_tuples: number;
  readonly oldest_transaction_s: number;
  readonly bloat_percent: number;
  readonly alerts: readonly string[];
}

// Table level, so no tenant takes part and the report holds counts only. A second run stands
// aside rather than waits: the next tick will look again.
export async function maintainFilterRows(
  session: FilterMaintenanceSession,
  afterImport: boolean,
): Promise<MaintenanceReport> {
  const facts = await readFacts(session);
  const plan = planMaintenance(facts, afterImport);
  const { rows } = await session.query(`select pg_try_advisory_lock(${String(LOCK_KEY)}) as held`);
  const held = rows[0]?.['held'] === true;
  if (held) {
    try {
      if (plan.vacuum) {
        for (const table of TABLES) await session.query(`vacuum (analyze) ${table}`);
      }
      if (plan.reindex) await rebuild(session);
    } finally {
      await session.query(`select pg_advisory_unlock(${String(LOCK_KEY)})`);
    }
  }
  return {
    event: 'engine.filter_rows.maintenance',
    ran: held,
    vacuum: held && plan.vacuum,
    reindex: held && plan.reindex,
    dead_tuples: facts.deadTuples,
    oldest_transaction_s: facts.oldestTransactionSeconds,
    bloat_percent: bloatPercent(facts),
    alerts: filterRowAlerts(facts),
  };
}

export interface MaintainCommandOptions {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
  readonly connect?: (env: MaintainCommandOptions['env']) => Promise<MaintenanceClient>;
}

export interface MaintenanceClient extends FilterMaintenanceSession {
  end(): Promise<void>;
}

const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

async function connectOwner(env: MaintainCommandOptions['env']): Promise<MaintenanceClient> {
  const client: pg.Client = createClient(parseMigrationConfig(env));
  await client.connect();
  await client.query(`set statement_timeout = ${String(WORK_TIMEOUT_MS)}`);
  return client;
}

// Runs as the migration role: it owns the tables, which vacuum and a rebuild need, and no app role
// should. Errors print a name and never server text, which can quote values.
export async function runMaintain(options: MaintainCommandOptions): Promise<number> {
  const { argv, stdout, stderr } = options;
  const [, target, flag, extra] = argv;
  if (
    target !== 'filter-rows' ||
    extra !== undefined ||
    ![undefined, '--after-import'].includes(flag)
  ) {
    stderr.write(`${MAINTAIN_USAGE}\n`);
    return EXIT_USAGE;
  }
  try {
    const client = await (options.connect ?? connectOwner)(options.env);
    try {
      const report = await maintainFilterRows(client, flag === '--after-import');
      stdout.write(`${JSON.stringify(report)}\n`);
      return 0;
    } finally {
      await client.end();
    }
  } catch (error) {
    const code = error instanceof Error ? Reflect.get(error, 'code') : undefined;
    stderr.write(`drefyn maintain: failed (${typeof code === 'string' ? code : 'unknown'})\n`);
    return EXIT_FAILED;
  }
}

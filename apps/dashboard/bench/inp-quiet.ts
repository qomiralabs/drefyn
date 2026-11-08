// Holds the 200 ms INP budget on a quiet machine: one run of the inp project at p75, with
// the load average beside every figure, because a busy machine reads as a slow page. Build
// and seed first, as for the e2e suite, then run with `pnpm --filter @drefyn/dashboard
// bench:inp`. It refuses to start when the 1 minute load is over DREFYN_BENCH_MAX_LOAD
// (default 1).
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { availableParallelism, cpus, loadavg } from 'node:os';
import { fileURLToPath } from 'node:url';
import { BUDGET_MS, summarize, type InpSummary } from '../e2e/inp-summary.ts';

const MAX_LOAD = Number(process.env['DREFYN_BENCH_MAX_LOAD'] ?? '1');
const app = fileURLToPath(new URL('../', import.meta.url));
const results = new URL('../test-results/inp/', import.meta.url);

const load = () =>
  loadavg()
    .map((value) => value.toFixed(2))
    .join(' ');

const before = loadavg()[0] ?? 0;
if (!(before < MAX_LOAD)) {
  process.stdout.write(`load ${load()} is over ${String(MAX_LOAD)}, so nothing was measured\n`);
  process.exit(2);
}

// Old files would read as this run's numbers if a scenario never got to write.
rmSync(results, { recursive: true, force: true });
const startLoad = load();
const run = spawnSync(
  'node_modules/.bin/playwright',
  ['test', '--project=inp', '--reporter=line'],
  { cwd: app, env: { ...process.env, DREFYN_QUIET_BENCH: 'on' }, stdio: 'inherit' },
);
const endLoad = load();

interface Recorded extends InpSummary {
  readonly readings: readonly { readonly press: number }[];
}

const rows = readdirSync(results)
  .filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(readFileSync(new URL(name, results), 'utf8')) as Recorded)
  .map((session) => ({
    session,
    press: summarize(
      session.name,
      session.readings.map((r) => r.press),
    ),
  }));

const misses = rows.filter(
  ({ session, press }) => session.p75 >= BUDGET_MS || press.p75 >= BUDGET_MS,
);
const cell = ({ p75, median, min, max }: InpSummary) =>
  `p75 ${String(p75)} ms (median ${String(median)}, ${String(min)} to ${String(max)})`;

process.stdout.write(
  [
    `INP quiet bench, ${String(availableParallelism())} x ${cpus()[0]?.model ?? 'unknown CPU'}, Node ${process.version}`,
    `load at start ${startLoad}, at end ${endLoad}, ceiling ${String(MAX_LOAD)}`,
    ...rows.map(
      ({ session, press }) =>
        `${session.name}: session ${cell(session)}; press ${cell(press)}; ${String(session.samples)} samples`,
    ),
    misses.length === 0 && rows.length > 0
      ? `every p75 is under the ${String(BUDGET_MS)} ms budget`
      : `over the ${String(BUDGET_MS)} ms budget: ${misses.map(({ session }) => session.name).join(', ') || 'no results'}`,
  ].join('\n') + '\n',
);
if (run.status !== 0 || misses.length > 0 || rows.length === 0) process.exitCode = 1;

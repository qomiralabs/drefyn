import { execFileSync } from 'node:child_process';
import { loadavg } from 'node:os';
import { parseArgs } from 'node:util';
import { composeArgs } from '../test/support/stack.ts';
import { copyProject, createProjects, loadPages, readSet, syntheticSet } from './load.ts';
import { ms, openHarness, percentile, scriptArgs, vacuum } from './stack.ts';

// Gate refusal latency: retrieveScored (retrieval and coverage in one statement), one client,
// as the public reader under forced RLS, in a project of each size with 10 other projects of
// 1,121 chunks beside it.
//   pnpm --filter @drefyn/retrieval bench [-- --sizes 11210,25000] [--set <dir>] [--runs 3]
// 11,210 is gated at p95 under 200 ms; any other size is reported only. Measure on a quiet
// host: the run refuses to start at a load average of 8 or more.
const GATED_SIZE = 11_210;
const BUDGET_MS = 200;
const MAX_LOAD = 8;

function containerLimits(): string {
  try {
    const id = execFileSync('docker', [...composeArgs(), 'ps', '-q', 'postgres'], {
      encoding: 'utf8',
    }).trim();
    const out = execFileSync(
      'docker',
      [
        'inspect',
        id,
        '--format',
        '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.Config.Image}}',
      ],
      { encoding: 'utf8' },
    ).trim();
    const [cpus = '0', memory = '0', image = ''] = out.split(' ');
    return `cpus ${String(Number(cpus) / 1e9)}, memory ${String(Number(memory) / 2 ** 20)} MiB, image ${image}`;
  } catch {
    return 'container limits unknown';
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: scriptArgs(),
    options: {
      sizes: { type: 'string', default: String(GATED_SIZE) },
      set: { type: 'string' },
      runs: { type: 'string', default: '3' },
    },
  });
  const sizes = values.sizes.split(',').map(Number);
  const runs = Number(values.runs);
  if (
    sizes.some((s) => !Number.isSafeInteger(s) || s < 1) ||
    !Number.isSafeInteger(runs) ||
    runs < 1
  ) {
    process.stderr.write('bench: --sizes takes whole numbers, --runs a whole number above 0\n');
    return 2;
  }
  const load = loadavg()[0] ?? 0;
  if (load >= MAX_LOAD) {
    process.stderr.write(
      `bench: load average ${load.toFixed(2)} is ${String(MAX_LOAD)} or more; not measuring\n`,
    );
    return 2;
  }
  const set = values.set === undefined ? syntheticSet() : readSet(values.set);
  const base = set.pages.reduce((sum, page) => sum + page.chunks.length, 0);
  process.stdout.write(
    `bench: ${values.set === undefined ? 'synthetic corpus' : 'question set'} of ${String(base)} chunks, ${String(set.questions.length)} questions; ${containerLimits()}; load ${load.toFixed(2)}\n`,
  );
  const harness = await openHarness('drefyn_bench');
  let pass = true;
  try {
    const [template, ...rest] = await createProjects(harness.name, 1 + 10 + sizes.length);
    if (template === undefined) throw new Error('no project');
    await loadPages(harness.name, template, set.pages);
    const others = rest.slice(0, 10);
    const targets = rest.slice(10);
    for (const other of others)
      await copyProject(harness.name, template, other, 0, { reverse: true });
    for (const [at, size] of sizes.entries()) {
      const target = targets[at];
      if (target === undefined) throw new Error('no target project');
      for (let k = 0; k * base < size; k += 1) {
        const left = size - k * base;
        await copyProject(harness.name, template, target, k, left < base ? { limit: left } : {});
      }
    }
    const started = performance.now();
    for (const project of [template, ...others, ...targets]) await harness.rebuild(project);
    await vacuum(harness.name);
    process.stdout.write(
      `bench: loaded and built term tables in ${ms((performance.now() - started) / 1000)} s\n`,
    );
    for (const [at, size] of sizes.entries()) {
      const target = targets[at];
      if (target === undefined) continue;
      const ask = (text: string) =>
        harness.retrieval.retrieveScored(target.tenant, { query: text, limit: 8 });
      // Warm the caches and the connection the way a running service is warm.
      for (const question of set.questions.slice(0, 30)) await ask(question.text);
      const p95s: number[] = [];
      for (let run = 0; run < runs; run += 1) {
        const times: number[] = [];
        let errors = 0;
        for (const question of set.questions) {
          const t0 = performance.now();
          const result = await ask(question.text);
          times.push(performance.now() - t0);
          if (!result.ok) errors += 1;
        }
        const p95 = percentile(times, 0.95);
        p95s.push(p95);
        process.stdout.write(
          `bench: size ${String(size)} run ${String(run + 1)}: p50 ${ms(percentile(times, 0.5))} ms, p95 ${ms(p95)} ms, max ${ms(percentile(times, 1))} ms, errors ${String(errors)}, load ${(loadavg()[0] ?? 0).toFixed(2)}\n`,
        );
        if (errors > 0 && size === GATED_SIZE) pass = false;
      }
      const worst = Math.max(...p95s);
      if (size === GATED_SIZE) {
        const ok = worst < BUDGET_MS;
        pass &&= ok;
        process.stdout.write(
          `bench: size ${String(size)} gated: worst p95 ${ms(worst)} ms, budget ${String(BUDGET_MS)} ms: ${ok ? 'pass' : 'FAIL'}\n`,
        );
      } else {
        process.stdout.write(
          `bench: size ${String(size)} reported: worst p95 ${ms(worst)} ms (not gated)\n`,
        );
      }
    }
  } finally {
    await harness.close();
  }
  return pass ? 0 : 1;
}

process.exitCode = await main();

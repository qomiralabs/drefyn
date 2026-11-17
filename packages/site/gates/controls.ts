// Proves each gate still catches the breach it exists for. Every control swaps one page for
// its broken twin, runs the real gate on it and expects exactly the right tests to fail, so
// a gate that quietly stops measuring fails here instead of passing everything.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { BREACH_ENV, type Breach } from './pages.ts';

export type Expect =
  | { readonly kind: 'fail'; readonly titles: RegExp; readonly message?: RegExp }
  | { readonly kind: 'warn'; readonly titles: RegExp }
  | { readonly kind: 'refused'; readonly output: RegExp };

export interface Control {
  readonly breach: Breach;
  readonly project: string;
  readonly grep: string;
  readonly expect: Expect;
}

export const CONTROLS: readonly Control[] = [
  {
    breach: 'docs-js',
    project: 'budgets',
    grep: 'JS budget',
    expect: { kind: 'fail', titles: /^docs-article loads its JS/, message: /not under 90000/ },
  },
  {
    breach: 'status-js',
    project: 'budgets',
    grep: 'JS budget',
    expect: { kind: 'fail', titles: /^status-home loads its JS/, message: /not under 50000/ },
  },
  {
    breach: 'docs-lighthouse',
    project: 'budgets',
    grep: 'lighthouse',
    expect: { kind: 'fail', titles: /^docs-article lighthouse/, message: /is under 95/ },
  },
  {
    breach: 'status-lighthouse',
    project: 'budgets',
    grep: 'lighthouse',
    expect: { kind: 'fail', titles: /^status-home lighthouse/, message: /is under 98/ },
  },
  {
    breach: 'status-lcp',
    project: 'budgets',
    grep: 'lighthouse',
    expect: {
      kind: 'fail',
      titles: /^status-home lighthouse/,
      message: /LCP \d+ ms is over 1000 ms/,
    },
  },
  {
    breach: 'first-response-warn',
    project: 'budgets',
    grep: 'first response|heaviest',
    expect: { kind: 'warn', titles: /^status-incident first response/ },
  },
  {
    breach: 'first-response-fail',
    project: 'budgets',
    grep: 'first response',
    expect: { kind: 'refused', output: /"budget":"first_response","limit":16000/ },
  },
  {
    breach: 'no-script',
    project: 'chromium',
    grep: 'scripts off',
    expect: { kind: 'fail', titles: /^status-home reads with scripts off/ },
  },
  {
    breach: 'axe',
    project: 'chromium',
    grep: 'axe',
    expect: { kind: 'fail', titles: /^docs-article has no axe/, message: /image-alt/ },
  },
  {
    breach: 'keyboard',
    project: 'chromium',
    grep: 'tabs through',
    expect: { kind: 'fail', titles: /^docs-article tabs/, message: /no visible focus ring/ },
  },
  {
    breach: 'reduced-motion',
    project: 'chromium',
    grep: 'reduced motion',
    expect: { kind: 'fail', titles: /^docs-article moves nothing/, message: /translate/ },
  },
  {
    breach: 'visual',
    project: 'visual-chromium',
    grep: 'looks as approved',
    expect: {
      kind: 'fail',
      titles: /^docs-article looks as approved/,
      message: /Screenshot comparison failed|pixels/,
    },
  },
];

export interface Outcome {
  readonly title: string;
  readonly status: string;
  readonly message: string;
  readonly warned: boolean;
}

interface JsonSpec {
  title: string;
  tests: {
    status: string;
    annotations?: { type: string }[];
    results: {
      error?: { message?: string };
      annotations?: { type: string }[];
      stdout?: { text?: string }[];
    }[];
  }[];
}
interface JsonSuite {
  specs?: JsonSpec[];
  suites?: JsonSuite[];
}

export function outcomes(report: { suites?: JsonSuite[] }): Outcome[] {
  const found: Outcome[] = [];
  const walk = (suite: JsonSuite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests) {
        const annotations = [
          ...(t.annotations ?? []),
          ...t.results.flatMap((r) => r.annotations ?? []),
        ];
        found.push({
          title: spec.title,
          status: t.status,
          message: stripVTControlCharacters(
            t.results.map((r) => r.error?.message ?? '').join('\n'),
          ),
          warned: annotations.some((a) => a.type === 'warning'),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return found;
}

// The Lighthouse lines a run printed, so a missed control shows what was measured and not
// only that the run passed.
export function measured(report: { suites?: JsonSuite[] }): string[] {
  const lines: string[] = [];
  const walk = (suite: JsonSuite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests) {
        for (const r of t.results) {
          for (const out of r.stdout ?? []) {
            for (const line of (out.text ?? '').split('\n')) {
              if (line.startsWith('lighthouse ')) lines.push(line.trim());
            }
          }
        }
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return lines;
}

// Empty when the run did what the control expects; otherwise what went wrong.
export function judge(
  expect: Expect,
  exitCode: number,
  results: Outcome[],
  output: string,
): string[] {
  const failed = results.filter((r) => r.status === 'unexpected');
  if (expect.kind === 'refused') {
    if (exitCode === 0) return ['the run passed'];
    return expect.output.test(output) ? [] : [`the output never matched ${String(expect.output)}`];
  }
  if (expect.kind === 'warn') {
    const problems: string[] = [];
    if (exitCode !== 0 || failed.length > 0) problems.push('a warning must not fail the run');
    if (!results.some((r) => r.warned && expect.titles.test(r.title))) {
      problems.push(`no warning on a test matching ${String(expect.titles)}`);
    }
    return problems;
  }
  const problems: string[] = [];
  if (exitCode === 0) problems.push('the run passed');
  if (failed.length === 0) problems.push('no test failed');
  for (const r of failed) {
    if (!expect.titles.test(r.title)) problems.push(`an unrelated test failed: ${r.title}`);
    else if (expect.message !== undefined && !expect.message.test(r.message)) {
      problems.push(`${r.title} failed for another reason: ${r.message.slice(0, 300)}`);
    }
  }
  return problems;
}

function run(control: Control): string[] {
  const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
  const scratch = mkdtempSync(join(tmpdir(), 'site-control-'));
  const report = join(scratch, 'report.json');
  try {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(import.meta.resolve('@playwright/test/cli')),
        'test',
        '-c',
        'playwright.gates.config.ts',
        `--project=${control.project}`,
        `--grep=${control.grep}`,
        '--reporter=json',
      ],
      {
        cwd: pkg,
        encoding: 'utf8',
        env: {
          ...process.env,
          [BREACH_ENV]: control.breach,
          PLAYWRIGHT_JSON_OUTPUT_NAME: report,
          FORCE_COLOR: '0',
        },
      },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    let parsed: { suites?: JsonSuite[]; errors?: { message?: string }[] } = {};
    try {
      parsed = JSON.parse(readFileSync(report, 'utf8')) as typeof parsed;
    } catch {
      // No report means the run stopped before any test, which the output explains.
    }
    const errors = (parsed.errors ?? []).map((e) => e.message ?? '').join('\n');
    const results = outcomes(parsed);
    for (const line of measured(parsed)) console.log(`  ${line}`);
    for (const r of results) {
      console.log(`  ${r.status.padEnd(10)} ${r.title}${r.warned ? ' (warning)' : ''}`);
      if (r.status !== 'unexpected') continue;
      // The lines that say which budget broke, without the rest of the diff.
      const why = r.message
        .split('\n')
        .filter((line) => /^\s*\+\s+"|^Error:|Screenshot|pixels/.test(line))
        .slice(0, 6);
      for (const line of why) console.log(`             ${line.trim()}`);
    }
    return judge(control.expect, result.status ?? 1, results, `${output}\n${errors}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main() {
  const only = process.argv.slice(2);
  const chosen = only.length === 0 ? CONTROLS : CONTROLS.filter((c) => only.includes(c.breach));
  if (chosen.length === 0) throw new Error(`no control named ${only.join(', ')}`);
  let broken = 0;
  for (const control of chosen) {
    console.log(`control ${control.breach} on ${control.project}`);
    const problems = run(control);
    if (problems.length === 0) {
      console.log(`  caught`);
    } else {
      broken += 1;
      for (const p of problems) console.log(`  MISSED: ${p}`);
    }
  }
  console.log(
    `${String(chosen.length - broken)} of ${String(chosen.length)} controls caught their breach`,
  );
  process.exitCode = broken === 0 ? 0 : 1;
}

if (import.meta.main) main();

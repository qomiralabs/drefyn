// Parse plus print against the budgets. Run on an idle machine: pnpm --filter @drefyn/mdx bench
// The best sample is the floor with no contention, so a busy machine can still say if the
// budget is out of reach.
// Plain Node, not vitest bench: its module runner adds to every call and it reports no p95.
import { cpus, loadavg } from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';
import { serialize } from '../src/serialize.ts';
import type { Dialect } from '../src/index.ts';
import { parseForStore } from '../src/parse.ts';
import { loadCorpus, policy } from '../test/helpers.ts';
import type { CorpusFile } from '../test/helpers.ts';

const LARGE_PAGE_BYTES = 100 * 1024;
const LARGE_BUDGET_MS = 50;
const CORPUS_BUDGET_MS = 15;
const WARM_UP = 30;
const SAMPLES = 120;
const CORPUS_ROUNDS = 7;
// Lets the garbage collector and the JIT threads settle, as a server between requests would.
const PAUSE_MS = 20;

const use = policy();

function roundTrip(source: string, dialect: Dialect): void {
  const result = parseForStore(source, dialect, use);
  if (!result.ok || serialize(result.value.ast) !== source) throw new Error('not byte stable');
}

const time = (source: string, dialect: Dialect) => {
  const started = performance.now();
  roundTrip(source, dialect);
  return performance.now() - started;
};

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

const FRONTMATTER = /^---\n[\s\S]*?\n---\n/;
const IMPORTS = /^import .*$/gm;

// A real long page is rare, so pages are real files joined until they pass 100 KB.
function largePage(files: readonly CorpusFile[], dialect: Dialect): string {
  let page = '';
  for (const { text } of files) {
    const body = text.replace(FRONTMATTER, '');
    // Pages share import names, and a repeated binding is a syntax error in one file.
    const next = [`${page}${body}\n\n`, `${page}${body.replace(IMPORTS, '')}\n\n`].find(
      (joined) => parseForStore(joined, dialect, use).ok,
    );
    if (next === undefined) continue;
    page = next;
    if (Buffer.byteLength(page) >= LARGE_PAGE_BYTES) return page;
  }
  throw new Error('the corpus is too small for a 100 KB page');
}

const corpus = loadCorpus();
const pick = (name: string, dialect: Dialect) =>
  corpus.filter((file) => file.dialect === dialect && file.file.startsWith(`${name}-`));

const pages: readonly (readonly [string, Dialect, string])[] = [
  ['mdx, Astro docs', 'mdx', largePage(pick('astro', 'mdx'), 'mdx')],
  ['mdx, Next docs', 'mdx', largePage(pick('next', 'mdx'), 'mdx')],
  ['md, Roslyn', 'md', largePage(pick('roslyn', 'md'), 'md')],
  ['md, Ant Design', 'md', largePage(pick('antd', 'md'), 'md')],
];

console.log(
  `node ${process.version}, ${cpus().length} cores, load ${loadavg()
    .map((value) => value.toFixed(1))
    .join(' ')}`,
);

let overBudget = false;
for (const [name, dialect, source] of pages) {
  for (let run = 0; run < WARM_UP; run += 1) roundTrip(source, dialect);
  const samples: number[] = [];
  for (let run = 0; run < SAMPLES; run += 1) {
    samples.push(time(source, dialect));
    await pause(PAUSE_MS);
  }
  const p95 = percentile(samples, 0.95);
  overBudget ||= p95 >= LARGE_BUDGET_MS;
  const size = Math.round(Buffer.byteLength(source) / 1024);
  console.log(
    `${name} (${size} KB): best ${Math.min(...samples).toFixed(1)} ms, p50 ${percentile(samples, 0.5).toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, budget ${LARGE_BUDGET_MS}`,
  );
}

const corpusSamples: number[] = [];
for (let round = 0; round < CORPUS_ROUNDS; round += 1) {
  for (const { text, dialect } of corpus) corpusSamples.push(time(text, dialect));
  await pause(PAUSE_MS);
}
const corpusP95 = percentile(corpusSamples, 0.95);
overBudget ||= corpusP95 >= CORPUS_BUDGET_MS;
console.log(
  `corpus (${corpus.length} files): p50 ${percentile(corpusSamples, 0.5).toFixed(1)} ms, p95 ${corpusP95.toFixed(1)} ms, budget ${CORPUS_BUDGET_MS}`,
);
console.log(`load after ${loadavg()[0]?.toFixed(1) ?? 'unknown'}`);
if (overBudget) {
  console.log('over budget');
  process.exitCode = 1;
}

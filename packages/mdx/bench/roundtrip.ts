// Parse plus print against the budgets. Run on an idle machine: pnpm --filter @drefyn/mdx bench
// The best sample is the floor with no contention, so a busy machine can still say if the
// budget is out of reach.
// Plain Node, not vitest bench: its module runner adds to every call and it reports no p95.
import { cpus, loadavg } from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';
import { merge3 } from '../src/merge3.ts';
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
const MERGE_BLOCKS = 61;
const MERGE_BUDGET_MS = 10;

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
// A real page of the size the budget names, with both sides at work: one paragraph edited at both
// ends, which prints and parses, plus an edit and an insert elsewhere.
function mergePage() {
  const pages = corpus.flatMap(({ text, dialect }) => {
    const parsed = dialect === 'mdx' ? parseForStore(text, dialect, use) : undefined;
    return parsed?.ok === true ? [{ text, blocks: parsed.value.ast.children.length }] : [];
  });
  const nearest = pages
    .filter(({ blocks }) => blocks <= MERGE_BLOCKS)
    .sort((a, b) => b.blocks - a.blocks)[0];
  if (nearest === undefined) throw new Error('the corpus has no page to merge');
  // The nearest real page, topped up to the size the budget names.
  const filler = 'Another plain paragraph of words.\n\n'.repeat(MERGE_BLOCKS - nearest.blocks);
  const text = `${nearest.text.trimEnd()}\n\n${filler}`;
  const parsed = parseForStore(text, 'mdx', use);
  if (!parsed.ok) throw new Error('the merge page did not parse');
  const page = { text, blocks: parsed.value.ast.children };
  const words = page.blocks.flatMap((block, index) =>
    block.type === 'paragraph' && (block.source?.raw ?? '').includes(' ') ? [index] : [],
  );
  const raw = (at: number | undefined) => page.blocks[at ?? 0]?.source?.raw ?? '';
  const first = raw(words[0]);
  const last = raw(words.at(-1));
  const edit = (from: string, to: string) => page.text.replace(from, to);
  const parse = (text: string) => {
    const result = parseForStore(text, 'mdx', use);
    if (!result.ok) throw new Error('an edited page did not parse');
    return result.value.ast;
  };
  const ours = edit(first, `Ours ${first}`).replace(last, `${last}\n\nA new block from ours.`);
  const theirs = edit(first, `${first} theirs`).replace(last, `${last} theirs`);
  return {
    blocks: page.blocks.length,
    base: parse(page.text),
    ours: parse(ours),
    theirs: parse(theirs),
  };
}

const { blocks, base, ours, theirs } = mergePage();
const mergeOnce = () => {
  const started = performance.now();
  if (!merge3(base, ours, theirs).ok) throw new Error('refused a merge');
  return performance.now() - started;
};
for (let run = 0; run < WARM_UP; run += 1) mergeOnce();
const mergeSamples: number[] = [];
for (let run = 0; run < SAMPLES * 4; run += 1) {
  mergeSamples.push(mergeOnce());
  if (run % 20 === 0) await pause(PAUSE_MS);
}
const mergeP99 = percentile(mergeSamples, 0.99);
overBudget ||= mergeP99 >= MERGE_BUDGET_MS;
console.log(
  `merge3 (${blocks} blocks): p50 ${percentile(mergeSamples, 0.5).toFixed(2)} ms, p99 ${mergeP99.toFixed(2)} ms, budget ${MERGE_BUDGET_MS}`,
);
console.log(`load after ${loadavg()[0]?.toFixed(1) ?? 'unknown'}`);
if (overBudget) {
  console.log('over budget');
  process.exitCode = 1;
}

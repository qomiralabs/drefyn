// Extraction time per 1,000 lines for each language, as input to the digest's time budget.
// Run with `pnpm bench`. Each fixture is repeated to about 1,000 lines and timed in this
// process, without the thread hop, so the number is the grammar and the walk alone.
import { readFileSync } from 'node:fs';
import { CODE_LANGUAGES, extractFile, loadGrammars } from '../src/index.ts';
import type { CodeLanguage } from '../src/index.ts';

const FIXTURES: Record<CodeLanguage, string> = {
  typescript: 'typescript/client.ts',
  tsx: 'tsx/badge.tsx',
  javascript: 'javascript/counter.js',
  python: 'python/client.py',
  go: 'go/client.go',
  rust: 'rust/lib.rs',
};
const RUNS = 25;
const LINES = 1_000;

const grammars = await loadGrammars();
const rows: string[] = [];
for (const language of CODE_LANGUAGES) {
  const one = readFileSync(
    new URL(`../test/fixtures/${FIXTURES[language]}.txt`, import.meta.url),
    'utf8',
  );
  const copies = Math.ceil(LINES / one.split('\n').length);
  const source = one.repeat(copies);
  const lines = source.split('\n').length;
  extractFile(language, source, grammars);
  const times: number[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    const began = performance.now();
    extractFile(language, source, grammars);
    times.push(performance.now() - began);
  }
  times.sort((a, b) => a - b);
  const per = (ms: number) => ((ms * LINES) / lines).toFixed(1);
  const median = times[Math.floor(RUNS / 2)] ?? 0;
  const p95 = times[Math.floor(RUNS * 0.95)] ?? 0;
  rows.push(`| ${language} | ${lines} | ${per(median)} | ${per(p95)} |`);
}
process.stdout.write(
  [
    '| Language | Lines | Median ms per 1,000 lines | p95 ms per 1,000 lines |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n') + '\n',
);

// Render against the budget. Run on an idle machine: pnpm --filter @drefyn/mdx bench:render
// Parse is timed beside it because the budget is for both. Over that budget this says so and
// still exits 0: parse alone was already over it, and nothing here can fix that.
import { cpus, loadavg } from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Dialect, MdxRoot } from '../src/index.ts';
import { parseForStore } from '../src/parse.ts';
import { renderSafe } from '../src/render.ts';
import { loadCorpus, policy } from '../test/helpers.ts';

const PAGE_BYTES = 100 * 1024;
const BUDGET_MS = 50;
const WARM_UP = 30;
const SAMPLES = 120;
const PAUSE_MS = 20;

const use = policy({ remoteImages: 'allow' });

const percentile = (sorted: readonly number[], fraction: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;

function largePage(name: string, dialect: Dialect): MdxRoot {
  let page = '';
  for (const { file, text, dialect: own } of loadCorpus()) {
    if (own !== dialect || !file.startsWith(`${name}-`)) continue;
    const joined = `${page}${text.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^import .*$/gm, '')}\n\n`;
    const result = parseForStore(joined, dialect, use);
    if (!result.ok) continue;
    page = joined;
    if (Buffer.byteLength(page) >= PAGE_BYTES) return result.value.ast;
  }
  throw new Error('the corpus is too small for a 100 KiB page');
}

function timed(run: () => void): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

const pages = [
  ['mdx, Astro docs', 'mdx', largePage('astro', 'mdx')],
  ['md, Ant Design', 'md', largePage('antd', 'md')],
] as const;

console.log(`node ${process.version}, ${cpus().length} cores, load ${loadavg()[0]?.toFixed(1)}`);
for (const [name, dialect, ast] of pages) {
  const source = ast.children
    .map((block) => `${block.source?.gapBefore}${block.source?.raw}`)
    .join('');
  const render = () => renderToStaticMarkup(renderSafe(ast, use));
  for (let run = 0; run < WARM_UP; run += 1) render();
  const renders: number[] = [];
  const parses: number[] = [];
  for (let run = 0; run < SAMPLES; run += 1) {
    renders.push(timed(render));
    parses.push(timed(() => parseForStore(source, dialect, use)));
    await pause(PAUSE_MS);
  }
  renders.sort((a, b) => a - b);
  parses.sort((a, b) => a - b);
  const both = percentile(renders, 0.95) + percentile(parses, 0.95);
  console.log(
    `${name}: render p50 ${percentile(renders, 0.5).toFixed(1)} ms, p95 ${percentile(renders, 0.95).toFixed(1)} ms, parse p95 ${percentile(parses, 0.95).toFixed(1)} ms, both ${both.toFixed(1)} ms, budget ${BUDGET_MS}`,
  );
}
console.log(`load after ${loadavg()[0]?.toFixed(1)}`);

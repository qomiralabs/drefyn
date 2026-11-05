import type { Dialect } from '../src/index.ts';
import { DEFAULT_LIMITS } from '../src/index.ts';
import { loadCorpus } from './helpers.ts';

const FRONTMATTER = /^---\n[\s\S]*?\n---\n/;
// Pages share import names, and a repeated binding is a syntax error in one file.
const MODULE_LINES = /^(?:import|export) .*$/gm;

const prefixes: Readonly<Record<Dialect, readonly string[]>> = {
  mdx: ['astro', 'next'],
  md: ['roslyn', 'antd'],
};

// Tables and lists run Markdown denser than MDX, where JSX is one node.
const REAL_SHARE: Readonly<Record<Dialect, number>> = { mdx: 0.5, md: 0.2 };
const SENTENCE = 'The quick brown fox jumps over the lazy dog, and then it does so again. ';
const PROSE = `${SENTENCE.repeat(8)}\n\n`;

const bytesOf = (text: string) => Buffer.byteLength(text, 'utf8');

// Dense docs reach maxNodes well before maxBytes, so real pages fill as much as a page can hold
// and paragraphs of prose fill the rest, landing on the limit exactly. No real page in the
// corpus is near this long, so this is the honest stand in for one.
export function honestPage(dialect: Dialect, size = DEFAULT_LIMITS.maxBytes): string {
  const wanted = prefixes[dialect];
  const bodies = loadCorpus()
    .filter((file) => file.dialect === dialect)
    .filter((file) => wanted.some((name) => file.file.startsWith(`${name}-`)))
    .map((file) => file.text.replace(FRONTMATTER, '').replace(MODULE_LINES, ''))
    .map((text) => `${text.trimEnd()}\n\n`);
  let page = '';
  const real = size * REAL_SHARE[dialect];
  for (let round = 0; bytesOf(page) < real; round += 1) page += bodies[round % bodies.length] ?? '';
  while (bytesOf(page) + bytesOf(PROSE) < size) page += PROSE;
  return `${page}${'a'.repeat(size - bytesOf(page) - 1)}\n`;
}

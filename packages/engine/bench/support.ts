import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const corpus = join(import.meta.dirname, '..', '..', 'mdx', 'test', 'fixtures', 'corpus');

// Real pages, smallest first, joined until they pass the size. md, since mdx pages share import
// names, and a repeated binding is a syntax error in one file.
export function pageOf(bytes: number): string {
  const pages = readdirSync(corpus)
    .filter((file) => file.endsWith('.md.txt'))
    .sort()
    .map((file) => readFileSync(join(corpus, file), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, ''))
    .sort((a, b) => a.length - b.length);
  let page = '';
  for (const text of pages) {
    page += `${text}\n\n`;
    if (Buffer.byteLength(page) >= bytes) return page;
  }
  throw new Error('the corpus is too small for this page');
}

export function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

export const rounded = (value: number): number => Number(value.toFixed(1));

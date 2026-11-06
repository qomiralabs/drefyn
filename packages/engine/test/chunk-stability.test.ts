import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_LIMITS, type Dialect, type MdxRoot } from '@drefyn/mdx';
import { describe, expect, it } from 'vitest';
// The parser runs in a killable host in production. This reads our own fixtures, so the plain
// entry is enough and the test needs no host.
import { parseForStore } from '../../mdx/src/parse.ts';
import { chunkNode } from '../src/index.ts';

const TIMEOUT_MS = 180_000;
const REPLACEMENT = 'zebra';
const WORD = /\b[A-Za-z]{4,}\b/;
const POSITIONS = [0, 0.5, 1];
const options = { targetChars: 800, maxChars: 2000 };

const corpus = join(import.meta.dirname, '..', '..', 'mdx', 'test', 'fixtures', 'corpus');

const policy = {
  version: 1,
  components: new Set<string>(),
  rawHtml: 'sanitize',
  remoteImages: 'proxy',
  linkProtocols: ['https', 'http', 'mailto'],
  limits: DEFAULT_LIMITS,
} as const;

// Pages with components the test does not list still parse: a warning, not a refusal.
function parsed(text: string, dialect: Dialect): MdxRoot | null {
  const result = parseForStore(text, dialect, policy);
  return result.ok ? result.value.ast : null;
}

// One word of the block at this share of the page's paragraphs, in place in the file.
function edited(text: string, root: MdxRoot, position: number): string | null {
  const paragraphs = root.children.filter(
    ({ type, source }) => type === 'paragraph' && WORD.test(source?.raw ?? ''),
  );
  const target = paragraphs[Math.round((paragraphs.length - 1) * position)];
  if (target?.source === undefined) return null;
  const { raw } = target.source;
  const at = text.indexOf(raw);
  if (at < 0) return null;
  return text.slice(0, at) + raw.replace(WORD, REPLACEMENT) + text.slice(at + raw.length);
}

describe('a one word edit on the corpus', () => {
  it(
    'leaves at least 95 percent of chunks unchanged',
    () => {
      let total = 0;
      let changed = 0;
      let edits = 0;
      for (const file of readdirSync(corpus).sort()) {
        const dialect: Dialect = file.endsWith('.mdx.txt') ? 'mdx' : 'md';
        const text = readFileSync(join(corpus, file), 'utf8');
        const root = parsed(text, dialect);
        if (root === null) continue;
        const before = chunkNode(root, options).map(({ body }) => body);
        for (const position of POSITIONS) {
          const next = edited(text, root, position);
          if (next === null) continue;
          const after = parsed(next, dialect);
          if (after === null) continue;
          const old = new Set(before);
          const bodies = chunkNode(after, options).map(({ body }) => body);
          total += bodies.length;
          changed += bodies.filter((body) => !old.has(body)).length;
          edits += 1;
        }
      }
      expect(edits).toBeGreaterThan(400);
      expect(changed / total).toBeLessThanOrEqual(0.05);
    },
    TIMEOUT_MS,
  );
});

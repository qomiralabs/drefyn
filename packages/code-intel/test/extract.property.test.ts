import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CODE_LANGUAGES, extractFile, loadGrammars } from '../src/index.ts';
import type { CodeLanguage } from '../src/index.ts';
import { fixture } from './helpers.ts';

const SOURCES: Record<CodeLanguage, string> = {
  typescript: fixture('typescript/client.ts'),
  tsx: fixture('tsx/badge.tsx'),
  javascript: fixture('javascript/counter.js'),
  python: fixture('python/client.py'),
  go: fixture('go/client.go'),
  rust: fixture('rust/lib.rs'),
};

const TOKENS = [
  '{',
  '}',
  '(',
  ')',
  '"',
  "'",
  '`',
  '/**',
  '*/',
  '#[',
  ':',
  '\n',
  'export ',
  'def ',
  'pub ',
];

// A mutation is an edit at a position: delete a span, insert random text or a token.
const mutation: fc.Arbitrary<Edit> = fc.oneof(
  fc.record({ kind: fc.constant('delete' as const), at: fc.nat(), length: fc.nat(40) }),
  fc.record({
    kind: fc.constant('insert' as const),
    at: fc.nat(),
    text: fc.string({ maxLength: 8 }),
  }),
  fc.record({
    kind: fc.constant('token' as const),
    at: fc.nat(),
    text: fc.constantFrom(...TOKENS),
  }),
);

type Edit =
  | { kind: 'delete'; at: number; length: number }
  | { kind: 'insert' | 'token'; at: number; text: string };

function mutate(source: string, edits: readonly Edit[]): string {
  let text = source;
  for (const edit of edits) {
    const at = text.length === 0 ? 0 : edit.at % text.length;
    text =
      edit.kind === 'delete'
        ? text.slice(0, at) + text.slice(at + edit.length)
        : text.slice(0, at) + edit.text + text.slice(at);
  }
  return text;
}

describe('extraction under mutation', () => {
  it.each(CODE_LANGUAGES)('never throws and always answers for %s', async (language) => {
    const grammars = await loadGrammars();
    fc.assert(
      fc.property(fc.array(mutation, { minLength: 1, maxLength: 6 }), (edits) => {
        const result = extractFile(language, mutate(SOURCES[language], edits), grammars);
        expect(Array.isArray(result.symbols)).toBe(true);
        expect(Array.isArray(result.routes)).toBe(true);
        expect(typeof result.partial).toBe('boolean');
        for (const symbol of result.symbols) {
          expect(symbol.startLine).toBeGreaterThanOrEqual(1);
          expect(symbol.signature).not.toMatch(/\s{2}|\n/);
        }
      }),
      { numRuns: 150 },
    );
  });

  it.each(CODE_LANGUAGES)('never throws on random text as %s', async (language) => {
    const grammars = await loadGrammars();
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 400 }), (source) => {
        expect(typeof extractFile(language, source, grammars).partial).toBe('boolean');
      }),
      { numRuns: 100 },
    );
  });

  it.each(CODE_LANGUAGES)('gives the same answer twice for %s', async (language) => {
    const grammars = await loadGrammars();
    expect(extractFile(language, SOURCES[language], grammars)).toEqual(
      extractFile(language, SOURCES[language], grammars),
    );
  });
});

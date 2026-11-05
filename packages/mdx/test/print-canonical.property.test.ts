import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseForStore, printCanonical, rawOf, serialize } from '../src/index.ts';
import type { Dialect, MdxBlock, MdxRoot } from '../src/index.ts';
import { dialectArbitrary, documentArbitrary } from '../fuzz/documents.ts';
import { loadCorpus, parsed, policy, VARIANTS } from './helpers.ts';
import { allNew, definitionsOf } from './print-helpers.ts';

const RUNS = 2_000;
// Three times the worst seen with the gate testing every package at once under coverage.
const TIMEOUT_MS = 180_000;

const reparse = (source: string, dialect: Dialect): MdxRoot | undefined => {
  const result = parseForStore(source, dialect, policy());
  return result.ok ? result.value.ast : undefined;
};

function expectBlockIdempotent(block: MdxBlock, dialect: Dialect, definitions: string) {
  const first = printCanonical(block, dialect);
  const context = definitions === '' ? `${first}\n` : `${first}\n\n${definitions}\n`;
  const again = reparse(context, dialect);
  if (again === undefined) throw new Error('a printed block does not parse');
  const [only] = again.children;
  if (only === undefined) {
    expect(first).toBe('');
    return;
  }
  expect(printCanonical(only, dialect)).toBe(first);
  expect(rawOf(only)).toBe(rawOf(block));
}

describe('printCanonical', () => {
  it(
    'is idempotent on every block of every generated document',
    () => {
      fc.assert(
        fc.property(documentArbitrary, dialectArbitrary, (source, dialect) => {
          const ast = reparse(source, dialect);
          if (ast === undefined) return;
          const definitions = definitionsOf(ast);
          for (const block of ast.children) expectBlockIdempotent(block, dialect, definitions);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT_MS,
  );

  it(
    'is idempotent on every block of the pinned corpus',
    () => {
      let blocks = 0;
      for (const { text, dialect } of loadCorpus()) {
        const ast = parsed(text, dialect);
        const definitions = definitionsOf(ast);
        for (const block of ast.children) {
          blocks += 1;
          expectBlockIdempotent(block, dialect, definitions);
        }
      }
      expect(blocks).toBeGreaterThan(5_000);
    },
    TIMEOUT_MS,
  );

  it(
    'gives one answer for the same block',
    () => {
      fc.assert(
        fc.property(documentArbitrary, dialectArbitrary, (source, dialect) => {
          const ast = reparse(source, dialect);
          for (const block of ast?.children ?? []) {
            const copy = JSON.parse(JSON.stringify(block)) as MdxBlock;
            expect(printCanonical(copy, dialect)).toBe(printCanonical(block, dialect));
          }
        }),
        { numRuns: RUNS / 4 },
      );
    },
    TIMEOUT_MS,
  );

  it(
    'leaves the block it was given alone',
    () => {
      fc.assert(
        fc.property(documentArbitrary, dialectArbitrary, (source, dialect) => {
          const ast = reparse(source, dialect);
          for (const block of ast?.children ?? []) {
            const before = structuredClone(block);
            printCanonical(block, dialect);
            expect(block).toEqual(before);
          }
        }),
        { numRuns: RUNS / 4 },
      );
    },
    TIMEOUT_MS,
  );
});

describe('a whole page of new blocks', () => {
  const printed = (ast: MdxRoot) => serialize(allNew(ast));

  function expectFixedPoint(source: string, dialect: Dialect) {
    const ast = reparse(source, dialect);
    if (ast === undefined) return;
    const first = printed(ast);
    const again = reparse(first, dialect);
    if (again === undefined) throw new Error('a printed page does not parse');
    expect(again.children.map(rawOf)).toEqual(ast.children.map(rawOf));
    expect(printed(again)).toBe(first);
  }

  it(
    'keeps its tree and settles after one print',
    () => {
      fc.assert(fc.property(documentArbitrary, dialectArbitrary, expectFixedPoint), {
        numRuns: RUNS,
      });
    },
    TIMEOUT_MS,
  );

  it(
    'settles for every file and line ending in the corpus',
    () => {
      for (const [index, { text, dialect }] of loadCorpus().entries()) {
        const derive = VARIANTS[index % VARIANTS.length]?.[1];
        expectFixedPoint(derive?.(text) ?? text, dialect);
      }
    },
    TIMEOUT_MS,
  );

  it(
    'never mixes line endings',
    () => {
      fc.assert(
        fc.property(documentArbitrary, dialectArbitrary, (source, dialect) => {
          const ast = reparse(source.replace(/\r\n?|\n/g, '\r\n'), dialect);
          if (ast === undefined) return;
          expect(printed(ast)).not.toMatch(/(?<!\r)\n|\r(?!\n)/);
        }),
        { numRuns: RUNS / 4 },
      );
    },
    TIMEOUT_MS,
  );
});

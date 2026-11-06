import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { serialize } from '../src/serialize.ts';
import type { Dialect } from '../src/index.ts';
import { parseForStore } from '../src/parse.ts';
import { documentArbitrary, dialectArbitrary } from '../fuzz/documents.ts';
import { policy } from './helpers.ts';

const RUNS = 2_000;
const GAP_SHAPE = new RegExp(`^${String.fromCharCode(0xfeff)}*[ \\t\\r\\n]*$`);
// Three times the worst seen with the gate testing every package at once under coverage.
const TIMEOUT_MS = 120_000;

function expectStable(source: string, dialect: Dialect) {
  const first = parseForStore(source, dialect, policy());
  if (!first.ok) {
    expect(first.error.length).toBeGreaterThan(0);
    return;
  }
  const { ast } = first.value;
  expect(serialize(ast)).toBe(source);
  // What the store hands back is JSON, so that form has to print the same bytes.
  expect(serialize(JSON.parse(JSON.stringify(ast)) as typeof ast)).toBe(source);
  const pieces = ast.children.map(({ source: block }) => {
    if (block === undefined) throw new Error('a parsed block has no source');
    expect(block.rawOf).toMatch(/^[0-9a-f]{64}$/);
    expect(block.gapBefore).toMatch(GAP_SHAPE);
    return block.gapBefore + block.raw;
  });
  expect(ast.tail).toMatch(GAP_SHAPE);
  expect(pieces.join('') + ast.tail).toBe(source);
}

describe('serialize after parse', () => {
  it(
    'gives back every generated document byte for byte',
    () => {
      fc.assert(fc.property(documentArbitrary, dialectArbitrary, expectStable), { numRuns: RUNS });
    },
    TIMEOUT_MS,
  );

  it(
    'is deterministic',
    () => {
      fc.assert(
        fc.property(documentArbitrary, dialectArbitrary, (source, dialect) => {
          expect(parseForStore(source, dialect, policy())).toEqual(
            parseForStore(source, dialect, policy()),
          );
        }),
        { numRuns: RUNS / 4 },
      );
    },
    TIMEOUT_MS,
  );

  it(
    'survives a document with bytes appended',
    () => {
      fc.assert(
        fc.property(
          documentArbitrary,
          dialectArbitrary,
          fc.constantFrom(
            '\n',
            '\r\n',
            '\r',
            '  ',
            '\t',
            '\n\n\n',
            String.fromCharCode(0xa0),
            ' \r\n \n',
          ),
          (source, dialect, trailing) => {
            expectStable(source + trailing, dialect);
          },
        ),
        { numRuns: RUNS / 4 },
      );
    },
    TIMEOUT_MS,
  );
});

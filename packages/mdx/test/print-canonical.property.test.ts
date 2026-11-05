import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { printCanonical, rawOf, serialize } from '../src/index.ts';
import type { Dialect, MdxBlock, MdxRoot } from '../src/index.ts';
import { parseForStore } from '../src/parse.ts';
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

function expectBlockIdempotent(block: MdxBlock, root: MdxRoot) {
  const { dialect } = root;
  // Frontmatter only exists at the very top, so nothing can go in front of it.
  const definitions = block.type === 'yaml' ? '' : definitionsOf(root, block);
  const first = printCanonical(block, dialect);
  const context = definitions === '' ? `${first}\n` : `${definitions}\n\n${first}\n`;
  const again = reparse(context, dialect);
  if (again === undefined) throw new Error('a printed block does not parse');
  const only = again.children.at(-1);
  if (only === undefined) throw new Error('a printed block is gone');
  expect(printCanonical(only, dialect)).toBe(first);
}

describe('printCanonical', () => {
  it(
    'is idempotent on every block of every generated document',
    () => {
      fc.assert(
        fc.property(documentArbitrary, dialectArbitrary, (source, dialect) => {
          const ast = reparse(source, dialect);
          if (ast === undefined) return;
          for (const block of ast.children) expectBlockIdempotent(block, ast);
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
        for (const block of ast.children) {
          blocks += 1;
          expectBlockIdempotent(block, ast);
        }
      }
      expect(blocks).toBeGreaterThan(3_500);
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

  const lf = (text: string) => text.replaceAll('\r\n', '\n');

  // A page with as many CRLF as LF can reparse to the other majority, so endings stay out of it.
  function settles(source: string, dialect: Dialect): boolean {
    const ast = reparse(source, dialect);
    if (ast === undefined) return true;
    const first = printed(ast);
    const again = reparse(first, dialect);
    if (again === undefined) throw new Error('a printed page does not parse');
    return (
      lf(printed(again)) === lf(first) &&
      again.children.map(rawOf).join() === ast.children.map(rawOf).join()
    );
  }

  it(
    'keeps its tree and settles after one print, for all but a sliver of generated pages',
    () => {
      let pages = 0;
      let settled = 0;
      fc.assert(
        fc.property(documentArbitrary, dialectArbitrary, (source, dialect) => {
          pages += 1;
          if (settles(source, dialect)) settled += 1;
        }),
        { numRuns: RUNS },
      );
      // Generated pages reach what the parser only sees mid paragraph: a footnote right after a
      // rule, html after a line break or a definition, an indented block right after a list. A
      // blank line reads those differently and no escape exists. The corpus below allows none.
      expect((pages - settled) / pages).toBeLessThan(0.01);
    },
    TIMEOUT_MS,
  );

  it(
    'settles for every file and line ending in the corpus',
    () => {
      for (const [index, { file, text, dialect }] of loadCorpus().entries()) {
        const derive = VARIANTS[index % VARIANTS.length]?.[1];
        expect(settles(derive?.(text) ?? text, dialect), file).toBe(true);
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
          if (ast?.eol !== 'crlf') return;
          expect(printed(ast)).not.toMatch(/(?<!\r)\n|\r(?!\n)/);
        }),
        { numRuns: RUNS / 4 },
      );
    },
    TIMEOUT_MS,
  );
});

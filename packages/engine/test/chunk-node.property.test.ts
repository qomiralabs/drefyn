import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { chunkNode } from '../src/index.ts';
import { sourceOf, treeOf, type BlockSpec } from './support/tree.ts';

const line = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.string({ unit: 'binary', maxLength: 300 }),
  fc.string({ unit: 'grapheme', minLength: 900, maxLength: 2600 }),
  fc.constant('\u{1F600}'.repeat(1400)),
);

const raw = fc
  .array(line, { minLength: 1, maxLength: 12 })
  .chain((lines) => fc.constantFrom('\n', '\r\n', ' ').map((end) => lines.join(end)));

const block: fc.Arbitrary<BlockSpec> = fc
  .record({
    raw,
    gap: fc.constantFrom('', '\n', '\n\n', '\n\n\n\n'),
    heading: fc.option(
      fc.record({
        depth: fc.constantFrom<1 | 2 | 3 | 4 | 5 | 6>(1, 2, 3, 4, 5, 6),
        text: fc.string({ maxLength: 500 }),
      }),
      { nil: undefined },
    ),
  })
  .map(({ heading, ...rest }) => (heading === undefined ? rest : { ...rest, heading }));

const page = fc
  .tuple(fc.array(block, { maxLength: 30 }), fc.constantFrom('', '\n', 'trailing words\n'))
  .map(([blocks, tail]) => treeOf(blocks, tail));

const sizes = fc
  .tuple(fc.integer({ min: 2, max: 3000 }), fc.integer({ min: 0, max: 3000 }))
  .map(([targetChars, extra]) => ({ targetChars, maxChars: targetChars + extra }));

const RUNS = { numRuns: 200 };

describe('chunkNode', () => {
  it('gives the same chunks in the same order for the same content', () => {
    fc.assert(
      fc.property(page, sizes, (root, options) => {
        const again = structuredClone(root);
        expect(JSON.stringify(chunkNode(again, options))).toBe(
          JSON.stringify(chunkNode(root, options)),
        );
      }),
      RUNS,
    );
  });

  it('concatenates back to the text', () => {
    fc.assert(
      fc.property(page, sizes, (root, options) => {
        const bodies = chunkNode(root, options).map(({ body }) => body);
        expect(bodies.join('')).toBe(sourceOf(root));
      }),
      RUNS,
    );
  });

  it('holds the cap, numbers from zero, leaves no empty chunk and never splits a character', () => {
    fc.assert(
      fc.property(page, sizes, (root, options) => {
        const wellFormedBefore = sourceOf(root).isWellFormed();
        chunkNode(root, options).forEach((chunk, index) => {
          expect(chunk.ord).toBe(index);
          expect(chunk.body.length).toBeGreaterThan(0);
          expect(chunk.body.length).toBeLessThanOrEqual(options.maxChars);
          if (wellFormedBefore) expect(chunk.body.isWellFormed()).toBe(true);
        });
      }),
      RUNS,
    );
  });
});

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { chunkNode } from '../src/index.ts';
import { chunksBySection, sectionOf, sourceOf, treeOf, type BlockSpec } from './support/tree.ts';

// Long lines are one short text repeated: drawing thousands of random characters per line costs
// seconds a run, and the cap and the pair check only care about length and where a pair falls.
const longLine = fc
  .tuple(
    fc.constantFrom('x', 'word ', '\u{1F600}', 'a\u{1F600}'),
    fc.integer({ min: 100, max: 1400 }),
  )
  .map(([text, times]) => text.repeat(times));

const line = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.string({ unit: 'binary', maxLength: 300 }),
  longLine,
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
const TIMEOUT_MS = 30_000;

describe('chunkNode', () => {
  it(
    'gives the same chunks in the same order for the same content',
    () => {
      fc.assert(
        fc.property(page, sizes, (root, options) => {
          const again = structuredClone(root);
          expect(JSON.stringify(chunkNode(again, options))).toBe(
            JSON.stringify(chunkNode(root, options)),
          );
        }),
        RUNS,
      );
    },
    TIMEOUT_MS,
  );

  it(
    'concatenates back to the text',
    () => {
      fc.assert(
        fc.property(page, sizes, (root, options) => {
          const bodies = chunkNode(root, options).map(({ body }) => body);
          expect(bodies.join('')).toBe(sourceOf(root));
        }),
        RUNS,
      );
    },
    TIMEOUT_MS,
  );

  it(
    'holds the cap, numbers from zero, leaves no empty chunk and never splits a character',
    () => {
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
    },
    TIMEOUT_MS,
  );
});

describe('an edit', () => {
  const body = fc.array(raw, { minLength: 1, maxLength: 5 });
  const section = fc.record({ title: fc.string({ maxLength: 30 }), bodies: body });
  const edit = fc.oneof(
    fc.constant((text: string) => text.replace(/\w+/, 'zebra')),
    fc.constant((text: string) => text.replace(/\w+/, 'z'.repeat(24))),
    fc.constant((text: string) => `${text} One more plain sentence ends this block.`),
    fc.string({ maxLength: 900 }).map((text) => () => text),
  );

  const specsOf = (
    sections: readonly { readonly title: string; readonly bodies: readonly string[] }[],
  ): BlockSpec[] =>
    sections.flatMap(({ title, bodies }, at) => [
      // Section 0 has no heading half the time, as a page's opening text does not.
      ...(at === 0 && title.length % 2 === 0
        ? []
        : [{ raw: `# ${title}`, heading: { depth: 1, text: title } } as const]),
      ...bodies.map((text) => ({ raw: text })),
    ]);

  it(
    'never changes a chunk outside its heading section',
    () => {
      fc.assert(
        fc.property(
          fc.array(section, { minLength: 2, maxLength: 8 }),
          fc.nat(),
          edit,
          sizes,
          fc.constantFrom('', '\n', 'trailing words\n'),
          (sections, pick, change, options, tail) => {
            const specs = specsOf(sections);
            const editable = specs.flatMap(({ heading }, at) =>
              heading === undefined ? [at] : [],
            );
            const target = editable[pick % editable.length] ?? 0;
            const changed = specs.map((spec, at) =>
              at === target ? { ...spec, raw: change(spec.raw) } : spec,
            );
            const before = treeOf(specs, tail);
            const after = treeOf(changed, tail);
            const home = sectionOf(before, target);
            const was = chunksBySection(before, chunkNode(before, options));
            const now = chunksBySection(after, chunkNode(after, options));
            const others = (found: typeof was) => [...found].filter(([key]) => key !== home);
            expect(others(now)).toEqual(others(was));
          },
        ),
        RUNS,
      );
    },
    TIMEOUT_MS,
  );
});

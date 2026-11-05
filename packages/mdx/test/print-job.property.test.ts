import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { printPage } from '../src/print-job.ts';
import type { Dialect, MdxRoot } from '../src/index.ts';
import { dialectArbitrary, documentArbitrary } from '../fuzz/documents.ts';
import { parseForStore } from '../src/parse.ts';
import { isolatedPolicy, loadCorpus, parsed, policy, VARIANTS } from './helpers.ts';
import { allNew, insert } from './print-helpers.ts';

const RUNS = 3_000;
const TIMEOUT_MS = 180_000;

const HOSTILE = [
  'word',
  '<script>x()</script>',
  '\n\n# inj',
  '\n\n<script>x()</script>\n\n',
  '1}\n\n# inj\n\n{2',
  '}',
  '{',
  '---',
  '\n---\n',
  '```',
  '\n```\n',
  '<!--',
  'import a from "a"',
  'export const a = 1',
  '[a]: b',
  '[^1]: b',
  '- a',
  '> a',
  '    a',
  '| a |\n| - |',
  '`',
  '\\',
  '&lt;',
  ' ',
  '\r\n',
];

const value = fc
  .array(fc.constantFrom(...HOSTILE), { minLength: 1, maxLength: 3 })
  .map((parts) => parts.join(''));

const literal = (type: string) => fc.record({ type: fc.constant(type), value });

const phrasing: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  node: fc.oneof(
    { depthSize: 'small', maxDepth: 3 },
    literal('text'),
    literal('inlineCode'),
    literal('html'),
    literal('mdxTextExpression'),
    fc.record({
      type: fc.constantFrom('emphasis', 'strong', 'delete'),
      children: fc.array(tie('node'), { minLength: 1, maxLength: 2 }),
    }),
    fc.record({
      type: fc.constant('mdxJsxTextElement'),
      name: fc.constantFrom('b', 'a b', 'Note href="x"'),
      attributes: fc.constant([]),
      children: fc.array(tie('node'), { maxLength: 2 }),
    }),
    fc.record({
      type: fc.constant('link'),
      url: value,
      title: fc.option(value),
      children: fc.array(tie('node'), { maxLength: 2 }),
    }),
  ),
})).node;

const inline = fc.array(phrasing, { minLength: 1, maxLength: 3 });

const flow: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  node: fc.oneof(
    { depthSize: 'small', maxDepth: 3 },
    fc.record({ type: fc.constant('paragraph'), children: inline }),
    fc.record({
      type: fc.constant('heading'),
      depth: fc.integer({ min: 1, max: 6 }),
      children: inline,
    }),
    fc.record({
      type: fc.constant('code'),
      value,
      lang: fc.option(value),
      meta: fc.option(value),
    }),
    literal('html'),
    literal('yaml'),
    literal('mdxFlowExpression'),
    literal('mdxjsEsm'),
    fc.record({ type: fc.constant('thematicBreak') }),
    fc.record({ type: fc.constant('definition'), identifier: value, label: value, url: value }),
    fc.record({
      type: fc.constant('blockquote'),
      children: fc.array(tie('node'), { minLength: 1, maxLength: 2 }),
    }),
    fc.record({
      type: fc.constant('list'),
      ordered: fc.boolean(),
      spread: fc.boolean(),
      children: fc.array(
        fc.record({
          type: fc.constant('listItem'),
          spread: fc.boolean(),
          children: fc.array(tie('node'), { minLength: 1, maxLength: 2 }),
        }),
        { minLength: 1, maxLength: 2 },
      ),
    }),
    fc.record({
      type: fc.constant('mdxJsxFlowElement'),
      name: fc.constantFrom('A', 'a.b', 'a b', 'Note href="x"'),
      attributes: fc.array(
        fc.record({
          type: fc.constant('mdxJsxAttribute'),
          name: fc.constantFrom('b', 'c d', 'href="x" e'),
          value: fc.oneof(value, fc.constant(null)),
        }),
        { maxLength: 2 },
      ),
      children: fc.array(tie('node'), { maxLength: 2 }),
    }),
  ),
})).node;

interface Walked {
  readonly type: string;
  readonly children?: readonly Walked[];
}

// Written apart from the check in the host, so a hole in that one cannot hide here too.
const LIVE = new Set([
  'html',
  'yaml',
  'mdxFlowExpression',
  'mdxTextExpression',
  'mdxjsEsm',
  'mdxJsxFlowElement',
  'mdxJsxTextElement',
]);

const liveNodes = (node: Walked): readonly string[] => [
  ...(LIVE.has(node.type) ? [node.type] : []),
  ...(node.children ?? []).flatMap(liveNodes),
];

const count = (root: { readonly children: readonly unknown[] }) =>
  (root.children as readonly Walked[]).flatMap(liveNodes).sort();

const flowKinds = (root: MdxRoot) => root.children.map(({ type }) => type);

const base = (dialect: Dialect) => parsed('', dialect);

const withBlocks = (dialect: Dialect, blocks: readonly unknown[]): MdxRoot =>
  blocks.reduce<MdxRoot>((root, block, at) => insert(root, at, block), base(dialect));

describe('printing then reparsing', () => {
  it(
    'never changes what a hostile tree means, and refuses when it would',
    () => {
      let printed = 0;
      fc.assert(
        fc.property(
          dialectArbitrary,
          fc.array(flow, { minLength: 1, maxLength: 3 }),
          (dialect, blocks) => {
            const tree = withBlocks(dialect, blocks);
            const result = printPage({ tree: JSON.stringify(tree), policy: isolatedPolicy() });
            if (!result.ok) return;
            printed += 1;
            // What came back is what the bytes parse to, read again here to be sure of it.
            const again = parseForStore(result.value.text, dialect, policy());
            if (!again.ok) throw new Error('a printed page does not parse');
            expect(count(again.value.ast)).toEqual(
              (blocks as readonly Walked[]).flatMap(liveNodes).sort(),
            );
            expect(flowKinds(again.value.ast)).toEqual(
              (blocks as readonly Walked[])
                .filter((block) => block.type !== 'paragraph' || block.children?.length !== 0)
                .map(({ type }) => type),
            );
          },
        ),
        { numRuns: RUNS },
      );
      // A property over nothing proves nothing, so enough of them have to get through.
      expect(printed).toBeGreaterThan(RUNS / 50);
    },
    TIMEOUT_MS,
  );

  it(
    'never refuses a page of generated blocks the parser accepted, unless it would change it',
    () => {
      let refused = 0;
      let pages = 0;
      fc.assert(
        fc.property(documentArbitrary, dialectArbitrary, (source, dialect) => {
          const first = parseForStore(source, dialect, policy());
          if (!first.ok) return;
          pages += 1;
          const tree = JSON.stringify(first.value.ast);
          expect(printPage({ tree, policy: isolatedPolicy() })).toMatchObject({
            ok: true,
            value: { text: source },
          });
          const fresh = JSON.stringify(allNew(first.value.ast));
          if (!printPage({ tree: fresh, policy: isolatedPolicy() }).ok) refused += 1;
        }),
        { numRuns: RUNS / 2 },
      );
      expect(refused / pages).toBeLessThan(0.02);
    },
    TIMEOUT_MS,
  );

  it(
    'lets every corpus page through as all new blocks',
    () => {
      for (const [index, { file, text, dialect }] of loadCorpus().entries()) {
        const derive = VARIANTS[index % VARIANTS.length]?.[1];
        const tree = JSON.stringify(allNew(parsed(derive?.(text) ?? text, dialect)));
        const result = printPage({ tree, policy: isolatedPolicy() });
        expect(result.ok ? 'ok' : result.error[0]?.code, file).toBe('ok');
      }
    },
    TIMEOUT_MS,
  );
});

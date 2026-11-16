import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Dialect } from '../src/index.ts';
import { readerPage } from '../src/reader.ts';
import { policy } from './helpers.ts';
import { readerWords, unseenWords } from './reader-helpers.ts';
import { rootOf } from './render-helpers.ts';

const RUNS = 300;
const TIMEOUT_MS = 120_000;

const word = fc.constantFrom('alpha', 'beta', 'gamma', 'delta', 'SECRET', 'x1', 'zz');

// Shapes the reviews found, mixed with plain Markdown, so a page holds them in any order and
// split across blocks.
const fragment = fc.oneof(
  word.map((w) => `${w} words here`),
  word.map((w) => `# ${w}`),
  word.map((w) => `- ${w}\n- ${w}`),
  word.map((w) => `> ${w}`),
  word.map((w) => `| ${w} | b |\n| - | - |\n| c | ${w} |`),
  word.map((w) => `\`\`\`\n${w}\n\`\`\``),
  word.map((w) => `Ref[^${w}].`),
  word.map((w) => `[^${w}]: ${w} note`),
  word.map((w) => `<span hidden>${w}</span> shown`),
  word.map((w) => `<div hidden>\n\n${w}\n\n</div>`),
  word.map((w) => `<script>${w}</script>`),
  word.map((w) => `<script><!--<script></script>\n\n${w}`),
  word.map((w) => `<div '><template>'></div>\n\n${w}`),
  word.map((w) => `<object><table></object>\n\n${w}`),
  word.map((w) => `<template>\n\n${w}\n\n</template>`),
  word.map((w) => `<style>${w}</style>`),
  word.map((w) => `<textarea>${w}</textarea>`),
  word.map((w) => `<!-- ${w} -->`),
  word.map((w) => `[${w}](https://${w}.test)`),
  word.map((w) => `![${w}](https://${w}.test)`),
  fc.constantFrom('<div>', '</div>', '<a>', '</b>', '<details>', '</details>', '<noscript>'),
);

const mdxFragment = fc.oneof(
  fragment.filter((text) => !text.includes('<!--') && !text.includes("'>")),
  word.map((w) => `<Note>${w}</Note>`),
  word.map((w) => `<Foo>${w}</Foo>`),
  word.map((w) => `<>${w}</>`),
  word.map((w) => `{'${w}'}`),
);

const page = (dialect: Dialect) =>
  fc
    .array(dialect === 'md' ? fragment : mdxFragment, { minLength: 1, maxLength: 12 })
    .map((parts) => `${parts.join('\n\n')}\n`);

const use = (rawHtml: 'sanitize' | 'drop') => policy({ components: new Set(['Note']), rawHtml });

// The design implies this, as reader text is the render's own tree. Kept as a check on that.
describe('reader text on generated pages', () => {
  it.each([
    ['md', 'sanitize'],
    ['md', 'drop'],
    ['mdx', 'sanitize'],
    ['mdx', 'drop'],
  ] as const)(
    'holds no word the render does not show: %s, %s',
    (dialect, rawHtml) => {
      fc.assert(
        fc.property(page(dialect), (source) => {
          let unseen: readonly string[];
          try {
            unseen = unseenWords(source, dialect, use(rawHtml));
          } catch (error) {
            // A page the parser refuses never reaches a save, so it has no reader text either.
            if (error instanceof Error && error.message.startsWith('refused')) return;
            throw error;
          }
          expect(unseen).toEqual([]);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT_MS,
  );
});

// Every place a page can hold text no reader gets, in a tree built by hand so the shapes are not
// limited to what one parser happens to give.
const HIDDEN = 'CANARY';
const hiddenLeaf = fc.constantFrom(
  { type: 'html', value: `<!-- ${HIDDEN} -->` },
  { type: 'yaml', value: `key: ${HIDDEN}` },
  { type: 'definition', identifier: 'a', url: `https://${HIDDEN}.test`, title: HIDDEN },
  { type: 'mdxjsEsm', value: `export const a = '${HIDDEN}'` },
  { type: 'mdxFlowExpression', value: `'${HIDDEN}'` },
  { type: 'mdxTextExpression', value: `'${HIDDEN}'` },
  { type: 'footnoteReference', identifier: HIDDEN, label: HIDDEN },
  { type: 'someFutureNode', value: HIDDEN },
);
const shown = fc.constantFrom(
  { type: 'text', value: 'shown' },
  { type: 'inlineCode', value: 'shown' },
  { type: 'image', url: `https://${HIDDEN}.test`, title: HIDDEN, alt: 'shown' },
);
const leaf = fc.oneof(hiddenLeaf, shown);
const tree = fc.letrec<{ node: unknown }>((self) => ({
  node: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    leaf,
    fc.record({
      type: fc.constantFrom(
        'paragraph',
        'blockquote',
        'list',
        'listItem',
        'emphasis',
        'strong',
        'delete',
        'table',
        'tableRow',
        'tableCell',
        'footnoteDefinition',
      ),
      children: fc.array(self('node'), { maxLength: 4 }),
    }),
    fc.record({
      type: fc.constant('link'),
      url: fc.constant(`https://${HIDDEN}.test`),
      title: fc.constant(HIDDEN),
      children: fc.array(self('node'), { maxLength: 3 }),
    }),
    fc.record({
      type: fc.constantFrom('mdxJsxFlowElement', 'mdxJsxTextElement'),
      name: fc.constant(HIDDEN),
      attributes: fc.constant([{ type: 'mdxJsxAttribute', name: 'a', value: HIDDEN }]),
      children: fc.array(self('node'), { maxLength: 3 }),
    }),
  ),
}));

describe('reader text on trees built by hand', () => {
  it(
    'never holds text no reader gets, wherever it sits in the tree',
    () => {
      const blocks = fc.array(fc.record({ block: tree.node, heading: fc.boolean() }), {
        minLength: 1,
        maxLength: 8,
      });
      fc.assert(
        fc.property(blocks, fc.constantFrom('md', 'mdx'), (specs, dialect: Dialect) => {
          const children = specs.map(({ block, heading }) =>
            heading ? { type: 'heading', depth: 1, children: [block] } : block,
          );
          const use = policy({ components: new Set(['Note']) });
          const words = readerWords(readerPage(rootOf(children, dialect), use));
          expect(words.filter((word) => word.includes(HIDDEN))).toEqual([]);
        }),
        { numRuns: RUNS },
      );
    },
    TIMEOUT_MS,
  );
});

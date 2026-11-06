import type { Dialect } from '../src/index.ts';

export interface AstCase {
  readonly name: string;
  readonly dialect: Dialect;
  readonly source: string;
}

// Components the cases use, so a pin does not depend on the policy default.
export const CASE_COMPONENTS: ReadonlySet<string> = new Set(['Callout', 'Badge']);

// Between them these reach every node type and every byte the tree keeps outside a block. New
// cases go in a new version's pin: an old pin is what content of that version looks like.
export const AST_CASES: readonly AstCase[] = [
  { name: 'empty', dialect: 'md', source: '' },
  {
    name: 'blocks',
    dialect: 'md',
    source: [
      '# Heading',
      '',
      'Setext',
      '======',
      '',
      '> A quote',
      '',
      '- one',
      '- two',
      '',
      '3. three',
      '4. four',
      '',
      '```ts title="a.ts"',
      'const a = 1;',
      '```',
      '',
      '    indented code',
      '',
      '---',
      '',
      '<div>html</div>',
      '',
      '[ref]: https://example.com "Title"',
      '',
    ].join('\n'),
  },
  {
    name: 'inlines',
    dialect: 'md',
    source: [
      'Plain *emphasis* **strong** `code` [link](https://example.com "t").',
      'A hard  ',
      'break, ![image](a.png "alt"), [ref][ref], ![image ref][ref].',
      '',
      '[ref]: https://example.com',
      '',
    ].join('\n'),
  },
  {
    name: 'gfm',
    dialect: 'md',
    source: [
      '| a | b |',
      '| :-- | --: |',
      '| 1 | 2 |',
      '',
      '- [x] done',
      '- [ ] open',
      '',
      '~~gone~~ https://example.com note[^1]',
      '',
      '[^1]: The note.',
      '',
    ].join('\n'),
  },
  { name: 'yaml', dialect: 'md', source: '---\ntitle: A\n---\n\nBody\n' },
  {
    name: 'mdx',
    dialect: 'mdx',
    source: [
      "import { a } from './a.js';",
      '',
      'export const b = 1;',
      '',
      '<Callout kind="note" open>',
      '  Inside',
      '</Callout>',
      '',
      '{a + b}',
      '',
      'Text with <Badge label="new" /> and {b}.',
      '',
    ].join('\n'),
  },
  { name: 'crlf', dialect: 'md', source: '# A\r\n\r\nSome text\r\nover two lines\r\n' },
  { name: 'bom', dialect: 'md', source: '﻿# A\n' },
  { name: 'gaps-and-tail', dialect: 'md', source: '\n\n  # Indented\n\n\n\nLast\n\n\n' },
  { name: 'no-final-newline', dialect: 'md', source: 'Last' },
];

import { describe, expect, it } from 'vitest';
import { MdxPrintError, printCanonical, serialize } from '../src/index.ts';
import type { Dialect, MdastBlock, MdxBlock } from '../src/index.ts';
import { parsed } from './helpers.ts';

const first = (source: string, dialect: Dialect): MdxBlock => {
  const [block] = parsed(source, dialect).children;
  if (block === undefined) throw new Error('no block');
  return block;
};

const print = (source: string, dialect: Dialect = 'md') =>
  printCanonical(first(source, dialect), dialect);

// These strings are a stored format. If one has to change, that is an astVersion bump.
describe('canonical output per block kind', () => {
  const CASES: readonly (readonly [string, Dialect, string, string])[] = [
    ['paragraph', 'md', 'one *two* __three__\n', 'one *two* **three**'],
    ['paragraph with a soft break', 'md', 'one\ntwo\n', 'one\ntwo'],
    ['hard break', 'md', 'one  \ntwo\n', 'one\\\ntwo'],
    ['setext heading', 'md', 'Title\n===\n', '# Title'],
    ['closed heading', 'md', '## Title ##\n', '## Title'],
    ['indented code', 'md', '    code\n', '```\ncode\n```'],
    ['tilde fence', 'md', '~~~js title="a"\ncode\n~~~\n', '```js title="a"\ncode\n```'],
    ['fence longer than its content', 'md', '````\n```\n````\n', '````\n```\n````'],
    ['bullets', 'md', '* a\n* b\n', '- a\n- b'],
    ['nested bullets', 'md', '+ a\n  + b\n', '- a\n  - b'],
    ['ordered list', 'md', '3) a\n4) b\n', '3. a\n4. b'],
    ['loose list', 'md', '- a\n\n- b\n', '- a\n\n- b'],
    ['task list', 'md', '- [x] a\n- [ ] b\n', '- [x] a\n- [ ] b'],
    ['quote', 'md', '>a\n>b\n', '> a\n> b'],
    ['thematic break', 'md', '***\n', '---'],
    ['definition', 'md', '[a]: http://b.c  "d"\n', '[a]: http://b.c "d"'],
    ['table', 'md', '|a|b|\n|:-|-:|\n|c|d|\n', '| a | b |\n| :- | -: |\n| c | d |'],
    ['footnote', 'md', '[^1]: note\n', '[^1]: note'],
    ['frontmatter', 'md', '---\na: 1\n---\n', '---\na: 1\n---'],
    ['raw html', 'md', '<div>\n  a\n</div>\n', '<div>\n  a\n</div>'],
    ['link', 'md', '[a](<http://b.c> "t")\n', '[a](http://b.c "t")'],
    ['image', 'md', '![a](b.png)\n', '![a](b.png)'],
    ['strikethrough', 'md', '~~a~~\n', '~~a~~'],
    ['md leaves braces alone', 'md', 'a {b} <c\n', 'a {b} \\<c'],
    ['jsx', 'mdx', "<A  b='c'/>\n", '<A b="c" />'],
    ['jsx children', 'mdx', '<A>\n\ntext\n\n</A>\n', '<A>\n  text\n</A>'],
    ['expression', 'mdx', '{1  +  1}\n', '{1  +  1}'],
    ['esm', 'mdx', 'export const a = 1\n', 'export const a = 1'],
    ['mdx escapes braces', 'mdx', 'a \\{b} \\<c\n', 'a \\{b} \\<c'],
  ];

  it.each(CASES)('%s', (_name, dialect, source, expected) => {
    expect(print(source, dialect)).toBe(expected);
  });
});

describe('the faults found in the stock printer', () => {
  it('does not grow a nested expression on each pass', () => {
    const source = '<A>\n  <B>\n    {\n      a\n    }\n  </B>\n</A>\n';
    const once = print(source, 'mdx');
    expect(print(`${once}\n`, 'mdx')).toBe(once);
  });

  it('keeps the first value of a nested expression and its blank lines', () => {
    const once = print('<A>\n  <B>\n    {`a\n\nb`}\n  </B>\n</A>\n', 'mdx');
    expect(once).toContain('\n\n');
    expect(print(`${once}\n`, 'mdx')).toBe(once);
  });

  it('keeps esm inside jsx at column one', () => {
    const block: MdastBlock = {
      type: 'mdxJsxFlowElement',
      name: 'A',
      attributes: [],
      children: [{ type: 'mdxjsEsm', value: 'export const a = 1\n\nexport const b = 2' }],
    };
    expect(printCanonical(block, 'mdx')).toBe(
      '<A>\nexport const a = 1\n\nexport const b = 2\n</A>',
    );
  });

  it('does not put a blank line between jsx children in a tight list', () => {
    const source = '- <A>\n    <B />\n    <C />\n  </A>\n- d\n';
    expect(print(source, 'mdx')).toBe(source.trimEnd());
    const block = first(source, 'mdx');
    expect(block).toMatchObject({ spread: false, children: [{ spread: false }, {}] });
  });

  it('keeps the blank line between jsx children in a loose list', () => {
    expect(print('- <A>\n    <B />\n\n    <C />\n  </A>\n\n- d\n', 'mdx')).toContain(
      '\n\n    <C />',
    );
  });

  it('does not double a CRLF held in a value', () => {
    expect(print('```\r\na\r\nb\r\n```\r\n')).toBe('```\na\nb\n```');
    expect(print('one\r\ntwo\r\n')).toBe('one\ntwo');
  });

  it('runs in linear time on a run of spaces in a code block', () => {
    const block = first(`\`\`\`\n${' '.repeat(500_000)}x\n\`\`\`\n`, 'mdx');
    const started = performance.now();
    printCanonical(block, 'mdx');
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('text that looks like the printer', () => {
  const PRIVATE_USE = String.fromCharCode(0xe000);

  it('prints private use characters that sit in a value', () => {
    const value = `{\n  ${PRIVATE_USE}1${PRIVATE_USE}\n}`;
    const source = `<A>\n  <B>\n    ${value.replaceAll('\n', '\n    ')}\n  </B>\n</A>\n`;
    expect(print(source, 'mdx')).toContain(`${PRIVATE_USE}1${PRIVATE_USE}`);
  });

  it('refuses a block that uses every marker it could pick', () => {
    let every = '';
    for (let code = 0xe000; code <= 0xf8ff; code += 1) every += String.fromCharCode(code);
    const block: MdastBlock = {
      type: 'mdxJsxFlowElement',
      name: 'A',
      attributes: [],
      children: [{ type: 'mdxFlowExpression', value: `a\n${every}` }],
    };
    expect(() => printCanonical(block, 'mdx')).toThrow(MdxPrintError);
  });
});

describe('nodes the dialect cannot hold', () => {
  const block = (node: unknown) => node as MdastBlock;

  it('refuses mdx nodes in a markdown page', () => {
    expect(() => printCanonical(block({ type: 'mdxjsEsm', value: 'a' }), 'md')).toThrow(
      MdxPrintError,
    );
  });

  it('refuses raw html in an mdx page, which would parse as jsx', () => {
    expect(() => printCanonical(block({ type: 'html', value: '<a>' }), 'mdx')).toThrow(
      MdxPrintError,
    );
  });

  it('looks inside a block for them', () => {
    const quote = block({
      type: 'blockquote',
      children: [{ type: 'paragraph', children: [{ type: 'html', value: '<a>' }] }],
    });
    expect(() => printCanonical(quote, 'mdx')).toThrow(MdxPrintError);
    expect(printCanonical(quote, 'md')).toBe('> <a>');
  });

  it('refuses a kind it has never heard of, and says nothing of the content', () => {
    const unknown = block({ type: 'script', value: 'secret' });
    expect(() => printCanonical(unknown, 'md')).toThrow(MdxPrintError);
    expect(() => printCanonical(unknown, 'md')).not.toThrow('secret');
  });

  it('refuses frontmatter that would close early and spill text into the page', () => {
    const yaml = block({ type: 'yaml', value: 'a: 1\n---\n# spilled' });
    expect(() => printCanonical(yaml, 'md')).toThrow(MdxPrintError);
  });

  it('turns a tree too deep to print into the same error', () => {
    let deep: unknown = { type: 'text', value: 'a' };
    for (let depth = 0; depth < 100_000; depth += 1) {
      deep = { type: 'blockquote', children: [deep] };
    }
    expect(() => printCanonical(block(deep), 'md')).toThrow(MdxPrintError);
  });
});

describe('edited blocks', () => {
  it('escapes what would otherwise change the meaning', () => {
    const edited: MdastBlock = {
      type: 'paragraph',
      children: [{ type: 'text', value: '# not a *heading* <script>' }],
    };
    expect(printCanonical(edited, 'mdx')).toBe(
      '# not a \\*heading\\* \\<script>'.replace('# ', '\\# '),
    );
    expect(serialize(parsed('a\n', 'md')).length).toBe(2);
  });
});

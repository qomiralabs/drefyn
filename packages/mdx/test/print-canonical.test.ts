import { describe, expect, it } from 'vitest';
import { MdxPrintError, printCanonical } from '../src/print.ts';
import type { Dialect, MdastBlock, MdxBlock } from '../src/index.ts';
import { parsed } from './helpers.ts';

// These walk huge inputs, and the gate tests every package at once under coverage.
const SLOW_MS = 60_000;

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
    ['reference link', 'md', '[a][b]\n\n[b]: c\n', '[a][b]'],
    ['reference image', 'md', '![a][b]\n\n[b]: c\n', '![a][b]'],
    ['footnote reference', 'md', '[^1]\n\n[^1]: a\n', '[^1]'],
    ['inline jsx', 'mdx', '<b>x</b> y\n', '<b>x</b> y'],
    ['inline expression', 'mdx', 'a {b}\n', 'a {b}'],
    ['emphasis in a tight mdx list', 'mdx', '- *a* b\n', '- *a* b'],
    ['code holding a frontmatter fence', 'md', '```\n---\n```\n', '```\n---\n```'],
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
    } as unknown as MdastBlock;
    expect(printCanonical(block, 'mdx')).toBe(
      '<A>\nexport const a = 1\n\nexport const b = 2\n\n</A>',
    );
  });

  it('ends esm with a blank line, or it runs on into the closing tag', () => {
    const once = print('<div>\nexport const b = 1\n\n</div>\n', 'mdx');
    expect(once).toBe('<div>\nexport const b = 1\n\n</div>');
    expect(print(`${once}\n`, 'mdx')).toBe(once);
  });

  it('does not grow a whitespace only code line in a footnote', () => {
    const footnote = print('[^1]: a\n\n    ```\n      \n    ```\n');
    expect(footnote).toBe('[^1]: a\n\n    ```\n    ```');
  });

  it('keeps a whitespace only code line everywhere else', () => {
    expect(print('```\n  \n```\n')).toBe('```\n  \n```');
    const list = '- ```\n  a\n     \n  b\n  ```\n';
    expect(print(list)).toBe(list.trimEnd());
    const jsx = '<A>\n  ```\n  a\n    \n  b\n  ```\n</A>\n';
    expect(print(jsx, 'mdx')).toBe(jsx.trimEnd());
  });

  it('settles an item with a thematic break after its text', () => {
    const once = print('- item\n    ***\n  </Note>\n');
    expect(once).toBe('- item\n\n  ---\n\n  </Note>');
    expect(print(`${once}\n`)).toBe(once);
  });

  it('settles an item with a footnote definition after its text', () => {
    const item = '- item\n  [^1]: note\n';
    expect(parsed(item, 'md').children[0]).toMatchObject({ children: [{ spread: false }] });
    const once = print(item);
    expect(print(`${once}\n`)).toBe(once);
    const nested = print('- item\n[^1]\n\t[^1]: note\n<Note a="1">\n');
    expect(print(`${nested}\n`)).toBe(nested);
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

  it('folds a CRLF held in a jsx attribute', () => {
    expect(print('<A b="c\r\nd" {...e\r\n} g={h\r\n+ i} />\r\n', 'mdx')).not.toContain('\r');
  });

  it('dedents only what JSX added, not the list around it', () => {
    const source = '- <A>\n    {\n      a\n    }\n  </A>\n';
    expect(print(source, 'mdx')).toBe(source.trimEnd());
  });

  it('starts counting JSX depth again inside a list or a quote', () => {
    const list = '<A>\n  - <B>\n      {\n        c\n      }\n    </B>\n</A>\n';
    expect(print(list, 'mdx')).toBe(list.trimEnd());
    const quote = '<A>\n  > <B>\n  >   {\n  >     c\n  >   }\n  > </B>\n</A>\n';
    expect(print(quote, 'mdx')).toBe(quote.trimEnd());
  });

  it('keeps the blank line in a quote inside a tight item, where the item cannot see it', () => {
    const source = '- > <A>\n  >   <B />\n  >\n  >   <C />\n  > </A>\n- d\n';
    expect(print(source, 'mdx')).toBe(source.trimEnd());
  });

  it('keeps a blank line inside an attribute value clean', () => {
    const source = '<A\n  b={[\n\n    1,\n  ]}\n/>\n';
    expect(print(source, 'mdx')).toBe(source.trimEnd());
  });

  it('pins each kind of multi line attribute inside JSX', () => {
    const value = (type: string, text: string) => ({
      type: 'mdxJsxFlowElement',
      name: 'A',
      attributes: [],
      children: [
        {
          type: 'mdxJsxFlowElement',
          name: 'B',
          children: [],
          attributes: [
            type === 'mdxJsxExpressionAttribute'
              ? { type, value: text }
              : { type, name: 'c', value: text },
          ],
        },
      ],
    });
    const nested = (node: unknown) => printCanonical(node as MdastBlock, 'mdx');
    expect(nested(value('mdxJsxAttribute', 'd\ne'))).toBe('<A>\n  <B\n    c="d\ne"\n  />\n</A>');
    expect(nested(value('mdxJsxExpressionAttribute', '...d\ne'))).toBe(
      '<A>\n  <B\n    {...d\n  e}\n  />\n</A>',
    );
    const expression = {
      type: 'mdxJsxFlowElement',
      name: 'A',
      children: [],
      attributes: [
        { type: 'mdxJsxAttribute', name: 'b' },
        { type: 'mdxJsxAttribute', name: 'c', value: { type: 'x', value: 'd\ne' } },
      ],
    };
    expect(nested(expression)).toBe('<A\n  b\n  c={d\n  e}\n/>');
  });

  it('keeps a multi line attribute value at every depth', () => {
    const top = '<A\n  b={{\n    c: 1,\n  }}\n/>\n';
    expect(print(top, 'mdx')).toBe(top.trimEnd());
    const deep = '<A>\n  <B\n    c="d\ne"\n    {...f\n  }\n    h={i\n  + j}\n  />\n</A>\n';
    const once = print(deep, 'mdx');
    expect(print(`${once}\n`, 'mdx')).toBe(once);
  });

  it('keeps a table row shorter or longer than its header as it is', () => {
    expect(print('| a | b |\n|---|---|\n| c |\n| d | e | f |\n')).toBe(
      '| a | b |\n| - | - |\n| c |\n| d | e | f |',
    );
  });

  it('settles a heading whose only line break sits before html', () => {
    const once = print('a\n    <!-- b -->\n===\n');
    expect(once).toBe('# a <!-- b -->');
    expect(print(`${once}\n`)).toBe(once);
  });

  it('keeps a line break before html that cannot open a block', () => {
    expect(print('a\n<b>c\n')).toBe('a\n<b>c');
  });

  it('prints an escaped pipe in a table cell', () => {
    expect(print('| a |\n|---|\n| b\\|c |\n| `d\\|e` |\n')).toBe(
      '| a |\n| - |\n| b\\|c |\n| `d\\|e` |',
    );
  });

  it('prints a center aligned column', () => {
    expect(print('| a |\n|:-:|\n')).toBe('| a |\n| :-: |');
  });

  it('prints a long run of spaces in a value exactly', () => {
    const value = `${' '.repeat(50_000)}x`;
    expect(printCanonical({ type: 'code', value }, 'mdx')).toBe(`\`\`\`\n${value}\n\`\`\``);
  });
});

describe('text that looks like the printer', () => {
  const PRIVATE_USE = String.fromCharCode(0xe000);

  it('prints private use characters that sit in a value', () => {
    const value = `{\n  "${PRIVATE_USE}1${PRIVATE_USE}"\n}`;
    const source = `<A>\n  <B>\n    ${value.replaceAll('\n', '\n    ')}\n  </B>\n</A>\n`;
    expect(print(source, 'mdx')).toContain(`${PRIVATE_USE}1${PRIVATE_USE}`);
  });

  const holding = (last: number): MdastBlock => {
    let value = '';
    for (let code = 0xe000; code <= last; code += 1) value += String.fromCharCode(code);
    return { type: 'code', value };
  };

  it(
    'uses the last marker when every other one is taken',
    () => {
      expect(printCanonical(holding(0xf8fe), 'mdx')).toContain(String.fromCharCode(0xf8fe));
    },
    SLOW_MS,
  );

  it(
    'refuses a block that uses every marker it could pick',
    () => {
      expect(() => printCanonical(holding(0xf8ff), 'mdx')).toThrow(MdxPrintError);
    },
    SLOW_MS,
  );

  it('carries the block index, a name and no content in its error', () => {
    const error = new MdxPrintError(3);
    expect(error.name).toBe('MdxPrintError');
    expect(error.message).toBe('mdx.block_not_printable: block 3');
    expect(new MdxPrintError().blockIndex).toBe(0);
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

  it.each(['---', '--- \t', 'a: 1\n---\t\nb: 2'])(
    'refuses the frontmatter fence in %j',
    (value) => {
      expect(() => printCanonical(block({ type: 'yaml', value }), 'md')).toThrow(MdxPrintError);
    },
  );

  it.each(['a---', '---a', ' ---', 'a: ---b'])('prints frontmatter holding %j', (value) => {
    expect(printCanonical(block({ type: 'yaml', value }), 'md')).toBe(`---\n${value}\n---`);
  });

  it(
    'turns a tree too deep to print into the same error',
    () => {
      let deep: unknown = { type: 'text', value: 'a' };
      for (let depth = 0; depth < 100_000; depth += 1) {
        deep = { type: 'blockquote', children: [deep] };
      }
      expect(() => printCanonical(block(deep), 'md')).toThrow(MdxPrintError);
    },
    SLOW_MS,
  );
});

describe('values that would print live', () => {
  const inPage = (printed: string, dialect: Dialect) =>
    parsed(`${printed}\n`, dialect).children.map(({ type }) => type);

  it.each(['md', 'mdx'] as const)(
    'keeps a line ending in inline code on one line in %s',
    (dialect) => {
      const value = 'a\n\n<script>x()</script>';
      const block: MdastBlock = { type: 'paragraph', children: [{ type: 'inlineCode', value }] };
      expect(printCanonical(block, dialect)).toBe('`a  <script>x()</script>`');
      expect(inPage(printCanonical(block, dialect), dialect)).toEqual(['paragraph']);
    },
  );

  it('does the same with a backtick in the value and in a heading', () => {
    const value = '\`\n\n# inj\r\n';
    const code = { type: 'inlineCode', value };
    const paragraph = { type: 'paragraph', children: [code] } as MdastBlock;
    const heading = { type: 'heading', depth: 1, children: [code] } as MdastBlock;
    expect(inPage(printCanonical(paragraph, 'md'), 'md')).toEqual(['paragraph']);
    expect(printCanonical(heading, 'md')).toMatch(/^# /);
    expect(inPage(printCanonical(heading, 'md'), 'md')).toEqual(['heading']);
  });

  const yaml = { type: 'yaml', value: '<script>x()</script>\n\n# inj' };
  const CONTAINERS: readonly (readonly [string, Dialect, unknown])[] = [
    ['a quote', 'md', { type: 'blockquote', children: [yaml] }],
    ['a list item', 'md', { type: 'list', children: [{ type: 'listItem', children: [yaml] }] }],
    ['a footnote', 'md', { type: 'footnoteDefinition', identifier: 'a', children: [yaml] }],
    ['jsx', 'mdx', { type: 'mdxJsxFlowElement', name: 'A', attributes: [], children: [yaml] }],
  ];

  it.each(CONTAINERS)('refuses frontmatter nested in %s', (_name, dialect, block) => {
    expect(() => printCanonical(block as MdastBlock, dialect)).toThrow(MdxPrintError);
  });

  const element = (name: unknown, attribute = 'b') =>
    ({
      type: 'mdxJsxFlowElement',
      name,
      attributes: [{ type: 'mdxJsxAttribute', name: attribute, value: 'c' }],
      children: [],
    }) as MdastBlock;

  it.each(['Note href="javascript:x"', 'a b', 'a>', '1a', 'a.', '.a', 'a:b:c', 'a.b:c', ''])(
    'refuses %j as a jsx name',
    (name) => {
      expect(() => printCanonical(element(name), 'mdx')).toThrow(MdxPrintError);
    },
  );

  it.each(['a', 'A', 'a-b', 'a.b.c', 'a:b', '$a', '_a', 'été', 'a1'])(
    'prints %j as a name',
    (name) => {
      expect(printCanonical(element(name), 'mdx')).toContain(`<${name} `);
    },
  );

  it('prints a fragment, which has no name', () => {
    const fragment = { ...element(null), attributes: [] } as MdastBlock;
    expect(printCanonical(fragment, 'mdx')).toBe('<></>');
  });

  it.each(['href="javascript:x" b', 'a.b', 'a b', '1a', '', 'a:b:c', 'a='])(
    'refuses %j as an attribute name',
    (name) => {
      expect(() => printCanonical(element('A', name), 'mdx')).toThrow(MdxPrintError);
    },
  );

  it.each(['b', 'b-c', 'b:c', 'aria-label'])('prints %j as an attribute name', (name) => {
    expect(printCanonical(element('A', name), 'mdx')).toBe(`<A ${name}="c" />`);
  });

  it('checks the names of inline jsx and of nested jsx too', () => {
    const inline = {
      type: 'paragraph',
      children: [{ type: 'mdxJsxTextElement', name: 'a b', attributes: [], children: [] }],
    } as MdastBlock;
    expect(() => printCanonical(inline, 'mdx')).toThrow(MdxPrintError);
    const nested = { ...element('A'), children: [element('a b')] } as MdastBlock;
    expect(() => printCanonical(nested, 'mdx')).toThrow(MdxPrintError);
  });

  it('prints an attribute that spreads', () => {
    const spread = {
      ...element('A'),
      attributes: [{ type: 'mdxJsxExpressionAttribute', value: '...b' }],
    } as MdastBlock;
    expect(printCanonical(spread, 'mdx')).toBe('<A {...b} />');
  });

  it('encodes an ampersand in an attribute string, or it would decode on reparse', () => {
    const block = {
      ...element('A'),
      attributes: [{ type: 'mdxJsxAttribute', name: 'b', value: '&lt;script&gt;' }],
    } as MdastBlock;
    const once = printCanonical(block, 'mdx');
    expect(once).toBe('<A b="&amp;lt;script&amp;gt;" />');
    expect(parsed(`${once}\n`, 'mdx').children[0]).toMatchObject({
      attributes: [{ value: '&lt;script&gt;' }],
    });
  });

  it('never reads a table alignment off the object prototype', () => {
    const table = {
      type: 'table',
      align: ['constructor'],
      children: [{ type: 'tableRow', children: [{ type: 'tableCell', children: [] }] }],
    } as MdastBlock;
    expect(printCanonical(table, 'md')).not.toContain('native code');
    expect(printCanonical(table, 'md')).toContain('| - |');
  });
});

describe('a reference with a colon after it', () => {
  it('cannot turn into a footnote definition on its own line', () => {
    const source = '[^1]: a\n\nb\n    [^1]: c\n';
    const root = parsed(source, 'md');
    const [, block] = root.children;
    if (block === undefined) throw new Error('no block');
    const printed = printCanonical(block, 'md');
    expect(printed).toBe('b\n[^1]\\: c');
    expect(parsed(`[^1]: a\n\n${printed}\n`, 'md').children).toHaveLength(2);
  });

  it('cannot turn into a link definition at the start of a paragraph', () => {
    const source = '[a]: b\n\n    c\n\n[a]\\: d\n';
    const root = parsed(source, 'md');
    const block = root.children.at(-1);
    if (block === undefined) throw new Error('no block');
    const printed = printCanonical(block, 'md');
    expect(printed).toBe('[a]\\: d');
    expect(parsed(`[a]: b\n\n${printed}\n`, 'md').children.map(({ type }) => type)).toEqual([
      'definition',
      'paragraph',
    ]);
  });

  it('leaves a colon anywhere else alone', () => {
    expect(print('a: b [c: d\n')).toBe('a: b \\[c: d');
    expect(print('[a](b): c\n')).toBe('[a](b): c');
  });
});

describe('parser data on a node', () => {
  it('cannot pose as one of the marks', () => {
    const block = {
      type: 'mdxJsxFlowElement',
      name: 'A',
      attributes: [],
      data: { tight: true },
      children: [
        { type: 'mdxFlowExpression', value: 'a\nb', data: { dedent: '<script>' } },
        { type: 'mdxFlowExpression', value: 'c' },
      ],
    } as unknown as MdastBlock;
    expect(printCanonical(block, 'mdx')).toBe('<A>\n  {a\n  b}\n\n  {c}\n</A>');
  });
});

describe('edited blocks', () => {
  const paragraph = (value: string): MdastBlock => ({
    type: 'paragraph',
    children: [{ type: 'text', value }],
  });

  it.each(['import the module', 'export const a = 1', 'one\nimport two'])(
    'keeps text like %j from parsing as esm',
    (value) => {
      const printed = printCanonical(paragraph(value), 'mdx');
      expect(parsed(`${printed}\n`, 'mdx').children.map(({ type }) => type)).toEqual(['paragraph']);
      expect(printCanonical(paragraph(value), 'md')).toBe(value);
    },
  );

  it.each(['important exports', 'example text', 'an import here', 'to export this'])(
    'leaves %j alone',
    (value) => {
      expect(printCanonical(paragraph(value), 'mdx')).toBe(value);
    },
  );

  it('only escapes a byte order mark at the start of a line', () => {
    const value = `a${String.fromCharCode(0xfeff)}b`;
    expect(printCanonical(paragraph(value), 'md')).toBe(value);
  });

  it('keeps a byte order mark that opens a block', () => {
    const value = `${String.fromCharCode(0xfeff)}a`;
    const printed = printCanonical(paragraph(value), 'md');
    expect(parsed(printed, 'md').children[0]).toMatchObject({ children: [{ value }] });
  });

  it('escapes what would otherwise change the meaning', () => {
    const edited: MdastBlock = {
      type: 'paragraph',
      children: [{ type: 'text', value: '# not a *heading* <script>' }],
    };
    expect(printCanonical(edited, 'mdx')).toBe(
      '# not a \\*heading\\* \\<script>'.replace('# ', '\\# '),
    );
  });
});

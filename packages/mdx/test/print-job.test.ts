import { describe, expect, it } from 'vitest';
import { sourceOf } from '../src/canonical.ts';
import { printPage } from '../src/print-job.ts';
import type { MdxBlock, MdxIssueCode, MdxRoot, PrintResult } from '../src/index.ts';
import { rawOf } from '../src/index.ts';
import { isolatedPolicy, parsed } from './helpers.ts';
import { allNew, insert, without, withChild } from './print-helpers.ts';

const policy = isolatedPolicy();
const print = (root: unknown, use = policy): PrintResult =>
  printPage({ tree: JSON.stringify(root), policy: use });

const code = (result: PrintResult): MdxIssueCode | undefined =>
  result.ok ? undefined : result.error[0]?.code;

const text = (result: PrintResult): string => {
  if (!result.ok) throw new Error(`refused: ${result.error[0]?.code ?? 'none'}`);
  return result.value.text;
};

const paragraph = (value: string) => ({ type: 'paragraph', children: [{ type: 'text', value }] });
const expression = (value: string) => ({ type: 'mdxFlowExpression', value });

describe('printing a page in the host', () => {
  it('gives back the bytes and the parser tree of an untouched page', () => {
    const source = '# a\n\n* b\n';
    const result = print(parsed(source, 'md'));
    expect(text(result)).toBe(source);
    expect(result).toMatchObject({ ok: true, value: { issues: [] } });
  });

  it('says how long each step took, beside the tree and never in it', () => {
    const result = print(parsed('# a\n\n* b\n', 'md'));
    if (!result.ok) throw new Error('refused');
    const { timing, ast } = result.value;
    expect(Object.keys(timing ?? {}).sort()).toEqual([
      'compareMs',
      'decodeMs',
      'printMs',
      'reparseMs',
    ]);
    for (const ms of Object.values(timing ?? {})) expect(ms).toBeGreaterThanOrEqual(0);
    expect(timing?.reparseMs).toBeGreaterThan(0);
    expect(JSON.stringify(ast)).not.toContain('Ms');
  });

  it('prints an edit and hands back a tree whose source agrees with the bytes', () => {
    const root = parsed('old\n\n* b\n', 'md');
    const edited = withChild(root, 0, (block) => ({ ...block, ...paragraph('new') }) as MdxBlock);
    const result = print(edited);
    expect(text(result)).toBe('new\n\n* b\n');
    if (!result.ok) throw new Error('refused');
    const [first] = result.value.ast.children;
    expect(first?.source?.raw).toBe('new');
    expect(first?.source?.rawOf).toBe(first && rawOf(first));
  });

  it('allows what the parser reads differently but means the same', () => {
    const root = parsed('old\n', 'md');
    const edited = withChild(
      root,
      0,
      (block) => ({ ...block, ...paragraph('see https://example.com now') }) as MdxBlock,
    );
    expect(text(print(edited))).toContain('example.com');
  });

  it('ignores an empty paragraph an editor leaves behind', () => {
    const root = parsed('a\n', 'md');
    expect(text(print(insert(root, 1, { type: 'paragraph', children: [] })))).toContain('a');
  });
});

describe('a block printing its stored bytes', () => {
  const CHANGED = 'mdx.print_changed_meaning';
  const forged = (raw: string, source = 'Safe text\n') => {
    const root = parsed(source, 'md');
    return withChild(root, 0, (block) => {
      const tree = rawOf(block);
      const gapBefore = block.source?.gapBefore ?? '';
      const stored = { raw, gapBefore, rawOf: tree, sourceOf: sourceOf(tree, gapBefore, raw) };
      return { ...block, source: stored };
    });
  };

  it.each([
    ['other words', 'Wire money to Evil'],
    ['a live link', '[click](https://evil.test)'],
    ['a remote image', '![x](https://evil.test/t.png)'],
  ])('refuses forged bytes that only change %s', (_name, raw) => {
    expect(code(print(forged(raw)))).toBe(CHANGED);
  });

  it('refuses a forged reference that the tree does not hold', () => {
    expect(code(print(forged('[x][y]', 'Safe text\n\n[y]: https://evil.test\n')))).toBe(CHANGED);
  });

  it('holds an edit in the block beside it to the looser check', () => {
    const root = parsed('old\n\nkept\n', 'md');
    const edited = withChild(
      root,
      0,
      (block) => ({ ...block, ...paragraph('https://example.com') }) as MdxBlock,
    );
    expect(text(print(edited))).toBe('https\\://example.com\n\nkept\n');
  });

  it('lets a definition go, though the reference to it now reads as text', () => {
    const root = parsed('[a]\n\n[a]: b\n', 'md');
    expect(text(print(without(root, 1)))).toBe('[a]\n');
  });

  it('lets a definition arrive, though the text naming it now reads as a reference', () => {
    const root = parsed('[a]\n', 'md');
    const definition = { type: 'definition', identifier: 'a', label: 'a', url: 'b' };
    expect(text(print(insert(root, 1, definition)))).toContain('[a]: b');
  });

  it('keeps an empty paragraph from shifting which block is compared', () => {
    const root = parsed('kept\n', 'md');
    expect(text(print(insert(root, 0, { type: 'paragraph', children: [] })))).toContain('kept');
  });
});

describe('a tree that breaks the walks', () => {
  it.each([
    ['a null grandchild', { type: 'blockquote', children: [null] }],
    ['a number for children', { type: 'blockquote', children: 3 }],
    ['a value that is not text', { type: 'html', value: { a: 1 } }],
    ['a list for a value', { type: 'code', value: [1] }],
  ])('refuses %s without ending the thread', (_name, block) => {
    expect(code(print(insert(parsed('a\n', 'md'), 1, block)))).toMatch(/^mdx\./);
  });
});

describe('a page in CRLF', () => {
  it('prints in its own line ending', () => {
    expect(text(print(parsed('a\r\n\r\nb\r\n', 'md')))).toBe('a\r\n\r\nb\r\n');
  });
});

describe('a tree that is not a page', () => {
  it.each([
    ['not json', '{'],
    ['json of the wrong shape', '{"type":"root"}'],
    ['a list', '[]'],
    ['null', 'null'],
    ['the wrong version', JSON.stringify({ ...parsed('a\n', 'md'), astVersion: 2 })],
    ['children that are not nodes', JSON.stringify({ ...parsed('a\n', 'md'), children: [1] })],
    ['a child with no kind', JSON.stringify({ ...parsed('a\n', 'md'), children: [{}] })],
  ])('refuses %s', (_name, tree) => {
    expect(code(printPage({ tree, policy }))).toBe('mdx.block_not_printable');
  });

  it('refuses without saying what was in it', () => {
    const result = printPage({ tree: '{"secret": ', policy });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});

describe('refusals from the printer', () => {
  it('names a block it cannot print', () => {
    expect(code(print(insert(parsed('a\n', 'md'), 1, expression('b'))))).toBe(
      'mdx.block_not_printable',
    );
  });

  it('applies the limits in the policy', () => {
    const limits = { ...policy.limits, maxDepth: 1 };
    const quote = { type: 'blockquote', children: [paragraph('a')] };
    expect(code(print(insert(parsed('', 'md'), 0, quote), { ...policy, limits }))).toBe(
      'mdx.block_not_printable',
    );
  });
});

describe('a tree whose print means something else', () => {
  const CHANGED = 'mdx.print_changed_meaning';

  it('refuses a new block after an unclosed fence, which would hide it in the code', () => {
    const root = parsed('```\ncode\n', 'md');
    expect(code(print(insert(root, 1, paragraph('new'))))).toBe(CHANGED);
  });

  it('refuses a new block after an open comment, which would hide it in the html', () => {
    const root = parsed('<!-- open\n', 'md');
    expect(code(print(insert(root, 1, paragraph('new'))))).toBe(CHANGED);
  });

  it.each(['1}\n\n# inj\n\n{2', '}{', 'a}\n\n<script>x()</script>\n\n{b'])(
    'refuses a flow expression that breaks out: %j',
    (value) => {
      const result = print(insert(parsed('', 'mdx'), 0, expression(value)));
      expect(['mdx.print_changed_meaning', 'mdx.parse_failed']).toContain(code(result));
    },
  );

  it('refuses a text expression that breaks out', () => {
    const block = {
      type: 'paragraph',
      children: [{ type: 'mdxTextExpression', value: '1}\n\n# inj\n\n{2' }],
    };
    expect(code(print(insert(parsed('', 'mdx'), 0, block)))).toBe(CHANGED);
  });

  it('refuses html that is really a heading, or esm that is really text', () => {
    const html = { type: 'html', value: '<a>\n\n# inj' };
    expect(code(print(insert(parsed('', 'md'), 0, html)))).toBe(CHANGED);
    const esm = { type: 'mdxjsEsm', value: 'export const a = 1\n\n# inj' };
    expect(code(print(insert(parsed('', 'mdx'), 0, esm)))).toBe(CHANGED);
  });

  it('holds a fence against a line ending in its info string', () => {
    const block = { type: 'code', value: 'a', lang: 'x\ny' };
    const result = print(insert(parsed('', 'md'), 0, block));
    expect(result).toMatchObject({ ok: true, value: { ast: { children: [{ lang: 'x\ny' }] } } });
  });

  it('sees a changed jsx attribute', () => {
    const element = {
      type: 'mdxJsxFlowElement',
      name: 'A',
      children: [],
      attributes: [
        {
          type: 'mdxJsxAttribute',
          name: 'b',
          value: { type: 'mdxJsxAttributeValueExpression', value: 'c}  d={e' },
        },
      ],
    };
    expect(['mdx.print_changed_meaning', 'mdx.parse_failed']).toContain(
      code(print(insert(parsed('', 'mdx'), 0, element))),
    );
  });

  it('applies the policy to a tree no parser saw, as a stored page would', () => {
    const element = {
      type: 'mdxJsxFlowElement',
      name: 'Note',
      children: [],
      attributes: [
        {
          type: 'mdxJsxAttribute',
          name: 'a',
          value: { type: 'mdxJsxAttributeValueExpression', value: 'process.env' },
        },
      ],
    };
    const use = isolatedPolicy(['Note']);
    expect(code(print(insert(parsed('', 'mdx'), 0, element), use))).toBe('mdx.prop_not_literal');
  });

  it('holds on an ordinary page of new blocks', () => {
    const root: MdxRoot = allNew(
      parsed('# a\n\n> b\n\n- c\n\n```js\nd\n```\n\n<A e="f">\n  g\n</A>\n\n{h}\n', 'mdx'),
    );
    expect(text(print(root))).toContain('<A e="f">');
  });
});

import { describe, expect, it } from 'vitest';
import { printPage } from '../src/print-job.ts';
import type { MdxBlock, MdxIssueCode, MdxRoot, PrintResult } from '../src/index.ts';
import { rawOf } from '../src/index.ts';
import { isolatedPolicy, parsed } from './helpers.ts';
import { allNew, insert, withChild } from './print-helpers.ts';

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

describe('a tree that is not a page', () => {
  it.each([
    ['not json', '{'],
    ['json of the wrong shape', '{"type":"root"}'],
    ['a list', '[]'],
    ['null', 'null'],
    ['the wrong version', JSON.stringify({ ...parsed('a\n', 'md'), astVersion: 2 })],
    ['children that are not nodes', JSON.stringify({ ...parsed('a\n', 'md'), children: [1] })],
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

  it('refuses a changed code value, which is what a fence escape looks like', () => {
    const block = { type: 'code', value: 'a', lang: 'x\ny' };
    expect(code(print(insert(parsed('', 'md'), 0, block)))).toBe(CHANGED);
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

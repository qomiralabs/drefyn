import { describe, expect, it } from 'vitest';
import { merge3 } from '../src/merge3.ts';
import { mergePage } from '../src/merge-job.ts';
import type { MdxBlock, MdxRoot } from '../src/index.ts';
import { rawOf } from '../src/index.ts';
import { isolatedPolicy, parsed } from './helpers.ts';

const BASE = 'One line here.\n\nTwo lines here.\n';
const base = parsed(BASE, 'md');
const NOT_PRINTABLE = { code: 'mdx.block_not_printable', severity: 'error', line: 1, column: 1 };
const refused = { ok: false, error: [NOT_PRINTABLE] };

const withBlock = (root: MdxRoot, block: unknown): MdxRoot => ({
  ...root,
  children: [...root.children, block as MdxBlock],
});

describe('merge3 on trees nobody should trust', () => {
  it.each([
    ['a child that is no node', 'text'],
    ['a child with no type', { value: 'x' }],
    ['a numeric type', { type: 1 }],
    ['a null child', null],
    ['children that are no list', { type: 'paragraph', children: 'text' }],
    ['a child inside that is no node', { type: 'paragraph', children: [7] }],
    ['attributes that are no list', { type: 'mdxJsxFlowElement', attributes: 'a' }],
  ])('refuses %s', (_name, block) => {
    expect(merge3(base, withBlock(base, block), base)).toEqual(refused);
    expect(merge3(base, base, withBlock(base, block))).toEqual(refused);
    expect(merge3(withBlock(base, block), base, base)).toEqual(refused);
  });

  it.each([
    ['no children', { ...base, children: undefined }],
    ['a wrong type', { ...base, type: 'paragraph' }],
    ['a future version', { ...base, astVersion: 2 }],
    ['an unknown dialect', { ...base, dialect: 'html' }],
    ['no tail', { ...base, tail: undefined }],
  ])('refuses a root with %s', (_name, root) => {
    expect(merge3(root as unknown as MdxRoot, base, base)).toEqual(refused);
  });

  it('refuses a tree holding data, which the hash cannot see and a renderer would honour', () => {
    const paragraph = base.children[0] as MdxBlock;
    const smuggled = { ...paragraph, data: { hProperties: { onclick: 'x()' } } };
    const ours = { ...base, children: [smuggled, ...base.children.slice(1)] };
    expect(merge3(base, ours, base)).toEqual(refused);
  });

  it('refuses a tree past the depth limit before anything recursive touches it', () => {
    let node: unknown = { type: 'text', value: 'x' };
    for (let depth = 0; depth < 200_000; depth += 1) {
      node = { type: 'blockquote', children: [node] };
    }
    const result = merge3(base, withBlock(base, node), base);
    expect(result).toEqual({
      ok: false,
      error: [{ code: 'mdx.merge_limit', severity: 'error', line: 1, column: 1 }],
    });
  });

  it('refuses sides of different dialects', () => {
    const other = parsed(BASE, 'mdx');
    const mismatch = {
      ok: false,
      error: [{ code: 'mdx.dialect_mismatch', severity: 'error', line: 1, column: 1 }],
    };
    expect(merge3(base, other, base)).toEqual(mismatch);
    expect(merge3(base, base, other)).toEqual(mismatch);
  });

  it('is not fooled by a forged source hash: the tree decides', () => {
    const edited = parsed('One FORGED here.\n\nTwo lines here.\n', 'md');
    const first = edited.children[0] as MdxBlock;
    const claim = base.children[0]?.source;
    if (claim === undefined) throw new Error('no source');
    const forged = { ...first, source: claim };
    expect(rawOf(forged)).not.toBe(claim.rawOf);
    const ours = { ...edited, children: [forged, ...edited.children.slice(1)] };
    const theirs = parsed('One THEIRS here.\n\nTwo lines here.\n', 'md');
    const result = merge3(base, ours, theirs);
    expect(result.ok && result.value.kind).toBe('conflict');
  });

  it('keeps a key that would pollute a prototype as plain data', () => {
    const block = JSON.parse('{"type":"thematicBreak","__proto__":{"polluted":true}}') as MdxBlock;
    const ours = withBlock(base, block);
    expect(merge3(base, ours, ours).ok).toBe(true);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('turns an inline merge of hostile text into a conflict, not a new block', () => {
    const text = 'Some plain words on a line here.\n';
    const ours = 'Some plain words on a line here\n';
    const theirs = '<div>\nSome plain words on a line here.\n';
    const result = merge3(parsed(text, 'md'), parsed(ours, 'md'), parsed(theirs, 'md'));
    expect(result.ok).toBe(true);
  });

  it('treats a paragraph too long to align as a conflict, not a stall', () => {
    const words = (seed: string) =>
      Array.from({ length: 6_000 }, (_, index) => `${seed}${index}`).join(' ');
    const long = parsed(`${words('b')}\n`, 'md');
    const ours = parsed(`${words('b').replace(/b(\d)/g, 'o$1')}\n`, 'md');
    const theirs = parsed(`${words('b').replace(/b(\d)/g, 't$1')}\n`, 'md');
    const result = merge3(long, ours, theirs);
    expect(result.ok && result.value.kind).toBe('conflict');
  });
});

describe('the merge job', () => {
  const policy = isolatedPolicy();
  const job = (trees: string, maxBlocks = 100) => ({ trees, policy, maxBlocks });
  const treesOf = (ours: MdxRoot, theirs: MdxRoot) => JSON.stringify({ base, ours, theirs });

  it('merges trees sent as text', () => {
    const ours = parsed('One OURS here.\n\nTwo lines here.\n', 'md');
    const theirs = parsed('One line here.\n\nTwo THEIRS here.\n', 'md');
    const result = mergePage(job(treesOf(ours, theirs)));
    if (!result.ok) throw new Error('refused');
    expect(result.value.issues).toEqual([]);
    expect(result.value.outcome.kind).toBe('clean');
  });

  it('applies its block limit', () => {
    const result = mergePage(job(treesOf(base, base), 1));
    expect(!result.ok && result.error[0]?.code).toBe('mdx.merge_limit');
  });

  it.each([
    ['text that is no JSON', 'CANARY'],
    ['a frame with a tree missing', JSON.stringify({ base, ours: base })],
    ['a list', '[]'],
    ['nothing', 'null'],
  ])('refuses %s, and says nothing of it', (_name, trees) => {
    expect(mergePage(job(trees))).toEqual(refused);
  });
});

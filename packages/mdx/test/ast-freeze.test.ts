import type { Nodes } from 'mdast';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { AST_VERSION, type BlockSource, type MdxRoot } from '../src/index.ts';
import { serialize } from '../src/serialize.ts';
import { AST_CASES, CASE_COMPONENTS } from './ast-cases.ts';
import { asStored, firstDifference, freezeProblems, pinnedVersions, readPin } from './ast-pins.ts';
import { parsed, policy } from './helpers.ts';

const use = policy({ components: CASE_COMPONENTS });
const trees = Object.fromEntries(
  AST_CASES.map(({ name, source, dialect }) => [name, asStored(parsed(source, dialect, use))]),
);
const pin = readPin(AST_VERSION);

// A Record, so a new node type in the mdast types stops this file compiling until a case
// covers it. An attribute is not a node there, but it is stored with a type like one.
const NODE_TYPES: Readonly<Record<Nodes['type'] | 'mdxJsxAttribute', true>> = {
  blockquote: true,
  break: true,
  code: true,
  definition: true,
  delete: true,
  emphasis: true,
  footnoteDefinition: true,
  footnoteReference: true,
  heading: true,
  html: true,
  image: true,
  imageReference: true,
  inlineCode: true,
  link: true,
  linkReference: true,
  list: true,
  listItem: true,
  mdxFlowExpression: true,
  mdxJsxAttribute: true,
  mdxJsxFlowElement: true,
  mdxJsxTextElement: true,
  mdxTextExpression: true,
  mdxjsEsm: true,
  paragraph: true,
  root: true,
  strong: true,
  table: true,
  tableCell: true,
  tableRow: true,
  text: true,
  thematicBreak: true,
  yaml: true,
};

function typesIn(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value !== 'object' || value === null) return found;
  const { type } = value as { readonly type?: unknown };
  if (typeof type === 'string') found.add(type);
  for (const child of Object.values(value)) typesIn(child, found);
  return found;
}

const changed = (edit: (tree: { children: { type: string }[]; extra?: boolean }) => void) => {
  const copy = structuredClone(trees);
  edit(copy['blocks'] as { children: { type: string }[] });
  return copy;
};

const check = (overrides: Partial<Parameters<typeof freezeProblems>[0]>) =>
  freezeProblems({ astVersion: AST_VERSION, versions: pinnedVersions(), pin, trees, ...overrides });

describe('the frozen AST', () => {
  it('still parses every case to its pin', () => {
    expect(check({})).toEqual([]);
  });

  it.each(AST_CASES.map((item) => [item.name, item] as const))(
    'prints the pinned tree of %s back to its source',
    (name, { source }) => {
      expect(serialize(pin[name] as MdxRoot)).toBe(source);
    },
  );

  it('keeps a pin for every version so far', () => {
    expect(pinnedVersions()).toEqual(Array.from({ length: AST_VERSION }, (_, index) => index + 1));
  });

  it('reaches every node type', () => {
    const found = [...typesIn(Object.values(pin))].sort();
    expect(found).toEqual(Object.keys(NODE_TYPES).sort());
  });

  it('pins the fields of the tree and of a block source', () => {
    expectTypeOf<keyof MdxRoot>().toEqualTypeOf<
      'type' | 'astVersion' | 'dialect' | 'eol' | 'children' | 'tail' | 'tailOf'
    >();
    expectTypeOf<keyof BlockSource>().toEqualTypeOf<'raw' | 'gapBefore' | 'rawOf' | 'sourceOf'>();
  });
});

describe('a change without a bump', () => {
  it('fails on a renamed node type', () => {
    const trees = changed((tree) => {
      const [first] = tree.children;
      if (first !== undefined) first.type = 'title';
    });
    expect(check({ trees })).toEqual([
      'case blocks changed at children.0.type without an astVersion bump',
    ]);
  });

  it('fails on a new field', () => {
    const trees = changed((tree) => {
      tree.extra = true;
    });
    expect(check({ trees })).toEqual(['case blocks changed at extra without an astVersion bump']);
  });

  it('fails on a dropped block', () => {
    const trees = changed((tree) => {
      tree.children.pop();
    });
    expect(check({ trees })[0]).toMatch(/^case blocks changed at children\.\d+ without/);
  });

  it('fails on a changed block hash', () => {
    const copy = structuredClone(trees);
    const block = (copy['blocks'] as MdxRoot).children[0];
    if (block?.source === undefined) throw new Error('the first block has no source');
    (block.source as { rawOf: string }).rawOf = '0'.repeat(64);
    expect(check({ trees: copy })).toEqual([
      'case blocks changed at children.0.source.rawOf without an astVersion bump',
    ]);
  });

  it('fails on a case dropped from the pin or missing from it', () => {
    const { empty: _gone, ...rest } = trees;
    expect(check({ trees: rest })).toEqual(['case empty is pinned but no longer exists']);
    expect(check({ trees: { ...trees, added: {} } })).toEqual(['case added has no pin']);
  });

  it('does not take an array for an object with the same keys', () => {
    expect(firstDifference({ value: ['a'] }, { value: { 0: 'a' } })).toBe('value');
  });
});

describe('a bump', () => {
  it('fails until the new version has a pin', () => {
    expect(check({ astVersion: 2, versions: [1], pin: null })).toEqual(['no pin for astVersion 2']);
  });

  it('passes with a pin of the new shape and the old one kept', () => {
    expect(check({ astVersion: 2, versions: [1, 2], pin: trees })).toEqual([]);
  });

  it('fails when an old pin goes', () => {
    expect(check({ astVersion: 2, versions: [2] })).toEqual(['no pin for astVersion 1']);
  });

  it('fails when the code falls behind a pin, since the version never goes back', () => {
    expect(check({ astVersion: 1, versions: [1, 2] })).toEqual([
      'pin for astVersion 2 is ahead of the code',
    ]);
  });
});

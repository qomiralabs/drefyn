import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { AST_VERSION, DEFAULT_LIMITS, validateTree } from '../src/index.ts';
import type { MdxLimits, MdxRoot, TreeProblem } from '../src/index.ts';
import { readPin } from './ast-pins.ts';
import { loadCorpus, parsed } from './helpers.ts';

const LIMITS: MdxLimits = { ...DEFAULT_LIMITS, maxBytes: 8 * DEFAULT_LIMITS.maxBytes };

const stored = (root: MdxRoot): unknown => JSON.parse(JSON.stringify(root));

const problemsOf = (value: unknown, limits = LIMITS): readonly TreeProblem[] => {
  const result = validateTree(value, limits);
  return result.ok ? [] : result.error;
};

type Mutable = Record<string, unknown> & { children: Record<string, unknown>[] };

const tree = (source = 'Hello *world*\n'): Mutable => stored(parsed(source)) as Mutable;

// Deep enough to overflow any recursive walk, built without recursion.
function deepTree(levels: number): Mutable {
  let node: Record<string, unknown> = { type: 'text', value: 'x' };
  for (let level = 0; level < levels; level += 1) node = { type: 'emphasis', children: [node] };
  return { ...tree(), children: [{ type: 'paragraph', children: [node] }] };
}

describe('validateTree accepts what the parser stores', () => {
  it('takes every pinned tree after a JSON round trip', () => {
    for (const [name, pin] of Object.entries(readPin(AST_VERSION))) {
      expect(problemsOf(pin), name).toEqual([]);
    }
  });

  it('takes every corpus page, with the same limits the parser ran under', () => {
    const corpus = loadCorpus();
    expect(corpus.length).toBeGreaterThan(100);
    for (const { text, dialect, file } of corpus) {
      expect(problemsOf(stored(parsed(text, dialect))), file).toEqual([]);
    }
  }, 120_000);

  it.each([
    ['an expression prop', '<Callout a={1} />\n'],
    ['a flag prop', '<Callout open />\n'],
    ['a fragment', '<>a</>\n'],
    ['a spread free element in text', 'a <b c="d" /> e\n'],
    ['aligned table', '| a | b |\n| :- | -: |\n| 1 | 2 |\n'],
    ['a task list', '- [x] a\n- [ ] b\n- c\n'],
    ['footnotes', 'a[^1]\n\n[^1]: b\n'],
    ['a reference', '[a][b] ![c][d]\n\n[b]: /x "t"\n[d]: /y\n'],
    ['frontmatter', '---\na: 1\n---\n\nb\n'],
    ['esm', 'export const a = 1\n'],
    ['an expression', '{1 + 1}\n\na {2} b\n'],
    ['a fenced code block', '```js title="a"\nb\n```\n'],
  ])('takes %s', (_name, source) => {
    expect(problemsOf(tree(source))).toEqual([]);
  });

  it('takes plain markdown with html', () => {
    expect(problemsOf(stored(parsed('<div>a</div>\n\nb <i>c</i>\n', 'md')))).toEqual([]);
  });

  it('takes any tree the parser gives', () => {
    const line = fc.stringMatching(/^[ -~]{0,30}$/);
    fc.assert(
      fc.property(fc.array(line, { maxLength: 8 }), (lines) => {
        const source = lines.join('\n');
        const result = parseMaybe(source);
        fc.pre(result !== undefined);
        expect(problemsOf(result)).toEqual([]);
      }),
      { numRuns: 200 },
    );
  }, 60_000);

  it('hands back the tree it read', () => {
    const value = tree();
    const result = validateTree(value, LIMITS);
    expect(result).toEqual({ ok: true, value });
  });
});

function parseMaybe(source: string): unknown {
  try {
    return stored(parsed(source));
  } catch {
    return undefined;
  }
}

describe('validateTree refuses a tree the parser never gives', () => {
  it.each([
    ['null', null],
    ['a string', 'root'],
    ['an array', []],
    ['a class instance', new Date()],
  ])('refuses %s at the root', (_name, value) => {
    expect(problemsOf(value)).toEqual([{ path: '', code: 'tree.invalid_shape' }]);
  });

  it('refuses an unknown node type', () => {
    const value = tree();
    value.children[0] = { type: 'script', value: 'x' };
    expect(problemsOf(value)).toEqual([{ path: 'children.0', code: 'tree.invalid_shape' }]);
  });

  it('refuses a node with no type', () => {
    const value = tree();
    value.children[0] = {};
    expect(problemsOf(value)).toEqual([{ path: 'children.0', code: 'tree.invalid_shape' }]);
  });

  it('refuses a key a node type does not have', () => {
    const value = tree();
    Object.assign(value.children[0] ?? {}, { extra: 1 });
    expect(problemsOf(value)).toEqual([{ path: 'children.0', code: 'tree.invalid_shape' }]);
  });

  it('refuses a key on the root', () => {
    expect(problemsOf({ ...tree(), extra: 1 })).toEqual([{ path: '', code: 'tree.invalid_shape' }]);
  });

  it('refuses source below the top level', () => {
    const value = tree();
    const inner = (value.children[0]?.['children'] as Record<string, unknown>[])[0];
    Object.assign(inner ?? {}, { source: value.children[0]?.['source'] });
    expect(problemsOf(value)).toEqual([
      { path: 'children.0.children.0', code: 'tree.invalid_shape' },
    ]);
  });

  it('refuses a wrong field type', () => {
    const value = tree('# a\n');
    Object.assign(value.children[0] ?? {}, { depth: 9 });
    expect(problemsOf(value)).toEqual([{ path: 'children.0', code: 'tree.invalid_shape' }]);
  });

  it('refuses children that are not a list', () => {
    const value = tree();
    Object.assign(value.children[0] ?? {}, { children: 'x' });
    expect(problemsOf(value)).toEqual([{ path: 'children.0', code: 'tree.invalid_shape' }]);
  });

  it('refuses a bad source hash field', () => {
    const value = tree();
    const source = value.children[0]?.['source'] as Record<string, unknown>;
    source['rawOf'] = 'nope';
    expect(problemsOf(value)).toEqual([{ path: 'children.0', code: 'tree.invalid_shape' }]);
  });

  it.each(['__proto__', 'constructor', 'prototype', 'data', 'position'])(
    'refuses %s as an own key, anywhere',
    (key) => {
      const root = JSON.parse(
        `{"type":"root","astVersion":1,"dialect":"mdx","eol":"lf","tail":"","tailOf":"${'0'.repeat(64)}",` +
          `"children":[{"type":"paragraph","children":[{"type":"text","value":"a","${key}":{}}]}]}`,
      ) as unknown;
      expect(problemsOf(root)).toEqual([
        { path: `children.0.children.0.${key}`, code: 'tree.forbidden_key' },
      ]);
    },
  );

  it('refuses a forbidden key on an attribute', () => {
    const value = tree('<Callout a="b" />\n');
    const attribute = (value.children[0]?.['attributes'] as object[])[0];
    Object.assign(attribute ?? {}, { position: {} });
    expect(problemsOf(value)).toEqual([
      { path: 'children.0.attributes.0.position', code: 'tree.forbidden_key' },
    ]);
  });

  it('keeps Object.prototype clean', () => {
    const before = Object.keys(Object.prototype);
    problemsOf(JSON.parse('{"__proto__":{"polluted":true}}'));
    expect(Object.keys(Object.prototype)).toEqual(before);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('caps the problems it lists', () => {
    const value = tree();
    value.children = Array.from({ length: 500 }, () => ({ type: 'nope' }));
    expect(problemsOf(value)).toHaveLength(20);
  });
});

describe('validateTree and astVersion', () => {
  it.each([[0], [2], [999], ['1'], [null], [1.5]])('refuses %s', (astVersion) => {
    expect(problemsOf({ ...tree(), astVersion })).toEqual([
      { path: 'astVersion', code: 'tree.unknown_version' },
    ]);
  });

  it('refuses a missing one', () => {
    const value = tree();
    delete value['astVersion'];
    expect(problemsOf(value)).toEqual([{ path: 'astVersion', code: 'tree.unknown_version' }]);
  });
});

describe('validateTree limits run before anything recursive', () => {
  it('stops a tree 200,000 levels deep without overflowing the stack', () => {
    expect(problemsOf(deepTree(200_000))).toEqual([
      { path: expect.stringContaining('children.0') as string, code: 'tree.too_deep' },
    ]);
  });

  it('goes as deep as the limit and no further', () => {
    const limits = { ...LIMITS, maxDepth: 10 };
    expect(problemsOf(deepTree(8), limits)).toEqual([]);
    expect(problemsOf(deepTree(9), limits)).toEqual([
      { path: expect.any(String) as string, code: 'tree.too_deep' },
    ]);
  });

  it('counts depth the way the parser does', () => {
    const limits = { ...DEFAULT_LIMITS, maxDepth: 4 };
    expect(problemsOf(stored(parsed('> > a\n', 'mdx', policyWith(limits))), limits)).toEqual([]);
  });

  it('counts nodes and attributes the way the parser does', () => {
    const value = stored(parsed('<A b="1" c="2" />\n'));
    expect(problemsOf(value, { ...LIMITS, maxNodes: 3 })).toEqual([]);
    expect(problemsOf(value, { ...LIMITS, maxNodes: 2 })).toEqual([
      { path: 'children.0', code: 'tree.too_many_nodes' },
    ]);
  });

  it('stops a list longer than the limit without reading it', () => {
    const value = tree();
    value.children = new Array(4_000_000_000) as Record<string, unknown>[];
    expect(problemsOf(value)).toEqual([{ path: 'children', code: 'tree.too_many_nodes' }]);
  });

  it('stops a long list inside a node without reading it', () => {
    const value = tree();
    Object.assign(value.children[0] ?? {}, { children: new Array(4_000_000_000) });
    expect(problemsOf(value)).toEqual([
      { path: 'children.0.children', code: 'tree.too_many_nodes' },
    ]);
  });

  it('stops a long attribute list without reading it', () => {
    const value = tree('<Callout />\n');
    Object.assign(value.children[0] ?? {}, { attributes: new Array(4_000_000_000) });
    expect(problemsOf(value)).toEqual([
      { path: 'children.0.attributes', code: 'tree.too_many_nodes' },
    ]);
  });

  it('counts bytes in UTF-8', () => {
    const value = tree('é'.repeat(50));
    const size = Buffer.byteLength(JSON.stringify(value));
    expect(problemsOf(value, { ...LIMITS, maxBytes: size })).toEqual([]);
    expect(problemsOf(value, { ...LIMITS, maxBytes: 150 })).toEqual([
      { path: expect.any(String) as string, code: 'tree.too_large' },
    ]);
  });

  it('never counts more bytes than the stored form holds', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (word) => {
        const source = `${word.replace(/[^a-z ]/g, '')}x\n`;
        const value = tree(source);
        const size = Buffer.byteLength(JSON.stringify(value));
        expect(problemsOf(value, { ...LIMITS, maxBytes: size })).toEqual([]);
      }),
      { numRuns: 50 },
    );
  }, 60_000);

  it('ends on a cycle', () => {
    const value = tree();
    const first = value.children[0] ?? {};
    (first['children'] as unknown[]).push(first);
    first['source'] = undefined;
    expect(problemsOf(value).length).toBeGreaterThan(0);
  });

  it('ends on one node shared many times over', () => {
    const value = tree();
    let node: Record<string, unknown> = { type: 'text', value: 'x' };
    for (let level = 0; level < 30; level += 1) {
      node = { type: 'emphasis', children: [node, node] };
    }
    value.children = [{ type: 'paragraph', children: [node] }];
    expect(problemsOf(value, { ...LIMITS, maxDepth: 64 })).toEqual([
      { path: expect.any(String) as string, code: 'tree.too_many_nodes' },
    ]);
  });
});

const policyWith = (limits: MdxLimits) => ({
  version: 1,
  components: new Set<string>(),
  rawHtml: 'sanitize' as const,
  remoteImages: 'proxy' as const,
  linkProtocols: ['https' as const],
  limits,
});

describe('validateTree and text jsonb cannot hold', () => {
  const LONE = String.fromCharCode(0xd800);

  it('refuses a NUL in a text value', () => {
    expect(problemsOf(tree('a\u0000b\n'))).toEqual([
      { path: expect.stringMatching(/^children\.0/) as string, code: 'tree.invalid_text' },
    ]);
  });

  it.each([
    ['high', String.fromCharCode(0xd800)],
    ['low', String.fromCharCode(0xdc00)],
  ])('refuses a lone %s surrogate', (_name, unit) => {
    const value = tree();
    const text = (value.children[0]?.['children'] as Record<string, unknown>[])[0];
    Object.assign(text ?? {}, { value: `a${unit}b` });
    expect(problemsOf(value)).toEqual([
      { path: 'children.0.children.0.value', code: 'tree.invalid_text' },
    ]);
  });

  it('takes a surrogate pair', () => {
    expect(problemsOf(tree('a \u{1F600} b\n'))).toEqual([]);
  });

  it('checks raw, gap and tail too', () => {
    const value = tree();
    const source = value.children[0]?.['source'] as Record<string, unknown>;
    source['raw'] = `a${LONE}`;
    source['gapBefore'] = 'b\u0000';
    value['tail'] = `c${LONE}`;
    expect(problemsOf(value)).toEqual(
      expect.arrayContaining([
        { path: 'children.0.source.raw', code: 'tree.invalid_text' },
        { path: 'children.0.source.gapBefore', code: 'tree.invalid_text' },
        { path: 'tail', code: 'tree.invalid_text' },
      ]),
    );
  });

  it('checks attribute names and values', () => {
    const value = tree('<Callout a="b" />\n');
    const attribute = (value.children[0]?.['attributes'] as Record<string, unknown>[])[0];
    Object.assign(attribute ?? {}, { value: `x${LONE}` });
    expect(problemsOf(value)).toEqual([
      { path: 'children.0.attributes.0.value', code: 'tree.invalid_text' },
    ]);
  });

  it('checks the text of an expression prop', () => {
    const value = tree('<Callout a={1} />\n');
    const attribute = (value.children[0]?.['attributes'] as Record<string, unknown>[])[0];
    Object.assign(attribute?.['value'] ?? {}, { value: 'x\u0000' });
    expect(problemsOf(value)).toEqual([
      { path: 'children.0.attributes.0.value.value', code: 'tree.invalid_text' },
    ]);
  });
});

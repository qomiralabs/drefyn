import { describe, expect, it } from 'vitest';
import { parseForStore } from '../src/index.ts';
import { codes, issuesOf, parsed, policy } from './helpers.ts';

const withNote = policy({ components: new Set(['Note', 'Tabs.Item']) });

describe('components', () => {
  it('warns on a component outside the registry, at its line', () => {
    expect(issuesOf('Hello\n\n<Evil />\n', 'mdx')).toEqual([
      { code: 'mdx.unknown_component', severity: 'warning', line: 3, column: 1 },
    ]);
  });

  it('warns on inline components and fragments too', () => {
    expect(codes(issuesOf('a <Evil /> b\n', 'mdx'))).toEqual(['mdx.unknown_component']);
    expect(codes(issuesOf('<>a</>\n', 'mdx'))).toEqual(['mdx.unknown_component']);
  });

  it('takes the registry from the policy, member names included', () => {
    expect(issuesOf('<Note />\n\n<Tabs.Item />\n', 'mdx', withNote)).toEqual([]);
  });

  it('is not fooled by names every object inherits', () => {
    const issues = issuesOf('<constructor />\n\n<__proto__ />\n\n<toString />\n', 'mdx');
    expect(codes(issues)).toEqual(Array(3).fill('mdx.unknown_component'));
  });

  it('does not judge the props of a component it will never render', () => {
    expect(codes(issuesOf('<Evil a={b} />\n', 'mdx'))).toEqual(['mdx.unknown_component']);
  });
});

describe('props', () => {
  const props = (text: string) => issuesOf(`<Note ${text} />\n`, 'mdx', withNote);

  it.each([
    'a="text"',
    'a',
    "a='x'",
    'a={1}',
    'a={-1}',
    'a={+1.5}',
    'a={"x"}',
    'a={true}',
    'a={null}',
    'a={`plain`}',
    'a={[1, "b", [true]]}',
    'a={{ b: 1, "c": [2] }}',
  ])('accepts the literal %s', (text) => {
    expect(props(text)).toEqual([]);
  });

  it.each([
    'a={b}',
    'a={b()}',
    'a={1 + 1}',
    'a={`x${y}`}',
    'a={/x/}',
    'a={10n}',
    'a={undefined}',
    'a={[...b]}',
    'a={[,1]}',
    'a={{ ...b }}',
    'a={{ [b]: 1 }}',
    'a={{ b }}',
    'a={{ b() {} }}',
    'a={{ __proto__: { x: 1 } }}',
    'a={{ "__proto__": 1 }}',
    'a={-b}',
    'a={!1}',
    'a={<Note />}',
    '{...b}',
  ])('refuses %s with a stable code and its place', (text) => {
    const issues = props(text);
    expect(issues).toContainEqual({
      code: 'mdx.prop_not_literal',
      severity: 'error',
      line: 1,
      column: 1,
    });
    expect(parseForStore(`<Note ${text} />\n`, 'mdx', withNote).ok).toBe(false);
  });

  it('checks inline components', () => {
    expect(codes(issuesOf('a <Note b={c} /> d\n', 'mdx', withNote))).toEqual([
      'mdx.prop_not_literal',
    ]);
  });
});

describe('parse failures', () => {
  it('refuses broken MDX with its place', () => {
    expect(issuesOf('Fine\n\n<Open>\n', 'mdx')).toEqual([
      expect.objectContaining({ code: 'mdx.parse_failed', severity: 'error', line: 3 }),
    ]);
  });

  it('refuses ESM that does not parse', () => {
    expect(codes(issuesOf('export const = 1\n', 'mdx'))).toEqual(['mdx.parse_failed']);
  });

  it('carries no customer text', () => {
    expect(JSON.stringify(issuesOf('<Secret-Name\n', 'mdx'))).not.toContain('Secret');
  });
});

describe('frontmatter', () => {
  it('accepts core schema YAML', () => {
    expect(issuesOf('---\na: 1\nb: [x, y]\n---\n\nBody\n', 'mdx')).toEqual([]);
  });

  it.each([
    ['bad syntax', 'a: [1'],
    ['a custom tag', 'a: !!js/function "x"'],
    ['a local tag', 'a: !evil 1'],
    ['a merge bomb', `a: &a [x]\n${'b: [*a, *a, *a]\n'.repeat(1)}c: &c [${'*a,'.repeat(200)}]`],
    ['deep flow nesting', `a: ${'['.repeat(1_900)}`],
  ])('reports %s', (_name, yaml) => {
    expect(codes(issuesOf(`---\n${yaml}\n---\n\nBody\n`, 'md'))).toContain(
      'mdx.frontmatter_invalid',
    );
  });

  it('keeps the bytes of a page with invalid frontmatter', () => {
    const source = '---\na: [1\n---\n\nBody\n';
    expect(parsed(source, 'md').children[0]?.source?.raw).toBe('---\na: [1\n---');
  });
});

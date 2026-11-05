import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../src/index.ts';
import { codes, issuesOf, limits, parsed } from './helpers.ts';

describe('mdx.too_large', () => {
  it('passes at the limit and refuses one byte over', () => {
    const atLimit = 'a'.repeat(100);
    expect(parsed(atLimit, 'md', limits({ maxBytes: 100 })).children).toHaveLength(1);
    expect(codes(issuesOf(atLimit, 'md', limits({ maxBytes: 99 })))).toEqual(['mdx.too_large']);
  });

  it('counts bytes, not characters', () => {
    expect(codes(issuesOf('é'.repeat(51), 'md', limits({ maxBytes: 101 })))).toEqual([
      'mdx.too_large',
    ]);
    expect(issuesOf('é'.repeat(51), 'md', limits({ maxBytes: 102 }))).toEqual([]);
  });

  it('refuses before the parser sees the page', () => {
    const issues = issuesOf('{'.repeat(1_000), 'mdx', limits({ maxBytes: 10 }));
    expect(issues).toEqual([{ code: 'mdx.too_large', severity: 'error', line: 1, column: 1 }]);
  });
});

describe('mdx.too_deep', () => {
  // Quote levels, then a paragraph, then its text.
  const quotes = (levels: number) => `${'> '.repeat(levels)}a\n`;

  it('passes at the limit and refuses one level over', () => {
    expect(issuesOf(quotes(8), 'md', limits({ maxDepth: 10 }))).toEqual([]);
    expect(codes(issuesOf(quotes(9), 'md', limits({ maxDepth: 10 })))).toEqual(['mdx.too_deep']);
  });

  it('counts nested JSX', () => {
    const nested = (levels: number) => `${'<a>'.repeat(levels)}x${'</a>'.repeat(levels)}\n`;
    const issues = issuesOf(nested(100), 'mdx', limits({ maxDepth: 64 }));
    expect(codes(issues)).toContain('mdx.too_deep');
  });

  it('holds with the default limit on a nesting bomb', () => {
    expect(codes(issuesOf(quotes(DEFAULT_LIMITS.maxDepth * 4), 'md'))).toEqual(['mdx.too_deep']);
  });
});

describe('mdx.too_many_nodes', () => {
  // Each paragraph is one block holding one text node.
  const paragraphs = (count: number) => 'a\n\n'.repeat(count);

  it('passes at the limit and refuses one node over', () => {
    expect(issuesOf(paragraphs(5), 'md', limits({ maxNodes: 10 }))).toEqual([]);
    expect(codes(issuesOf(paragraphs(5), 'md', limits({ maxNodes: 9 })))).toEqual([
      'mdx.too_many_nodes',
    ]);
  });

  it('counts JSX attributes, which take stored space like nodes', () => {
    const element = `<a ${'b="1" '.repeat(20)}/>\n`;
    expect(codes(issuesOf(element, 'mdx', limits({ maxNodes: 20 })))).toContain(
      'mdx.too_many_nodes',
    );
    expect(codes(issuesOf(element, 'mdx', limits({ maxNodes: 21 })))).not.toContain(
      'mdx.too_many_nodes',
    );
  });
});

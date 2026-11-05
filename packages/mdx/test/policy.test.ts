import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../src/index.ts';
import type { Dialect, RenderPolicy } from '../src/index.ts';
import { parseForStore } from '../src/parse.ts';
import { limits, parsed, policy } from './helpers.ts';

describe('the policy and dialect arguments', () => {
  it('uses the documented defaults', () => {
    expect(DEFAULT_LIMITS).toEqual({ maxBytes: 1_048_576, maxDepth: 64, maxNodes: 50_000 });
  });

  it('accepts a Map or a Set as the registry', () => {
    const map = policy({ components: new Map([['Note', { props: {} }]]) });
    expect(parsed('<Note />\n', 'mdx', map).children).toHaveLength(1);
  });

  it.each([
    ['a zero limit', limits({ maxBytes: 0 })],
    ['a fractional limit', limits({ maxNodes: 1.5 })],
    ['a depth the tree walks could not survive', limits({ maxDepth: 1_000_000 })],
    ['an unbounded size', limits({ maxBytes: Number.POSITIVE_INFINITY })],
    ['no registry', { ...policy(), components: undefined } as unknown as RenderPolicy],
  ])('throws on %s, which is our bug and not bad content', (_name, bad) => {
    expect(() => parseForStore('a', 'md', bad)).toThrow();
  });

  it('throws on an unknown dialect', () => {
    expect(() => parseForStore('a', 'html' as Dialect, policy())).toThrow();
  });

  it('throws on a source that is not a string', () => {
    expect(() => parseForStore(1 as unknown as string, 'md', policy())).toThrow();
  });
});

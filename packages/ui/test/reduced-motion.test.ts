import { describe, expect, it } from 'vitest';
import { renderTokensCss } from '../src/tokens/generate.ts';
import { reducedFadeCapMs, tokens, type Tokens } from '../src/tokens/tokens.ts';
import { findRule, parseRules } from './css.ts';

const REDUCE = '(prefers-reduced-motion: reduce)';

function motionUnderReduce(source: Tokens = tokens) {
  const rules = parseRules(renderTokensCss(source));
  const root = findRule(rules, ':root').declarations;
  const reduced = findRule(rules, ':root', REDUCE).declarations;
  // What the reader actually gets: the reduced value when redefined, the root value otherwise.
  const effective = new Map<string, string>();
  for (const [name, value] of root) {
    if (name.startsWith('--dr-duration-') || name.startsWith('--dr-distance-')) {
      effective.set(name, reduced.get(name) ?? value);
    }
  }
  return { effective, reduced };
}

const ms = (value: string) => {
  const match = /^(\d+(?:\.\d+)?)ms$/.exec(value);
  if (match?.[1] === undefined) throw new Error(`not a duration in ms: ${value}`);
  return Number(match[1]);
};

describe('reduced motion', () => {
  const { effective } = motionUnderReduce();

  it('stops everything that travels', () => {
    for (const name of ['move-fast', 'move-base', 'move-slow', 'brand-reveal']) {
      expect(effective.get(`--dr-duration-${name}`), name).toBe('0ms');
    }
    expect(effective.get('--dr-distance-enter')).toBe('0px');
  });

  it('keeps fades but caps them at 120 ms', () => {
    expect(effective.get('--dr-duration-fast')).toBe('120ms');
    expect(effective.get('--dr-duration-base')).toBe('120ms');
    expect(effective.get('--dr-duration-slow')).toBe('120ms');
  });

  it('leaves no duration above the cap and no movement above zero', () => {
    for (const [name, value] of effective) {
      if (name.startsWith('--dr-distance-')) expect(value, name).toBe('0px');
      else expect(ms(value), name).toBeLessThanOrEqual(reducedFadeCapMs);
    }
    for (const [key, d] of Object.entries(tokens.motion.duration)) {
      const name = `--dr-duration-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
      if (d.kind === 'move') expect(effective.get(name), name).toBe('0ms');
    }
  });

  it('derives the reduced values, so a new token cannot skip the rule', () => {
    const extra = {
      ...tokens,
      motion: {
        ...tokens.motion,
        duration: {
          ...tokens.motion.duration,
          sheet: { ms: 320, kind: 'move' },
          glow: { ms: 400, kind: 'fade' },
        },
      },
    } as unknown as Tokens;
    const { effective: withExtra } = motionUnderReduce(extra);
    expect(withExtra.get('--dr-duration-sheet')).toBe('0ms');
    expect(withExtra.get('--dr-duration-glow')).toBe('120ms');
  });
});

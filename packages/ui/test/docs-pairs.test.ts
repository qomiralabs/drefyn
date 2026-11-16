import { describe, expect, it } from 'vitest';
import {
  docsColorOf,
  docsDecorativeRoles,
  docsPairs,
  docsRoles,
  expandDocsPairs,
  measureDocs,
  minimum,
} from '../src/tokens/pairs.ts';
import { tokens } from '../src/tokens/tokens.ts';

const pairs = expandDocsPairs(docsPairs);

describe('docs contrast pairs', () => {
  it('checks both schemes', () => {
    expect(pairs.some((p) => p.mode === 'light')).toBe(true);
    expect(pairs.some((p) => p.mode === 'dark')).toBe(true);
    expect(pairs.length).toBeGreaterThan(200);
  });

  it.each(pairs.map((p) => [`${p.mode} ${p.fg} on ${p.bg}`, p] as const))(
    '%s meets WCAG 2.2 AA',
    (_, pair) => {
      expect(measureDocs(pair, pair.mode)).toBeGreaterThanOrEqual(minimum[pair.kind]);
    },
  );

  it('measures every docs colour, or says why it carries no meaning', () => {
    const used = new Set(pairs.flatMap((p) => [p.fg, p.bg.split('@').at(-1)]));
    const decorative = new Set(docsDecorativeRoles.map((d) => d.role));
    for (const role of docsRoles) {
      expect(used.has(role) || decorative.has(role), role).toBe(true);
    }
    for (const role of decorative) expect(used.has(role), role).toBe(false);
  });

  it('measures every wash over each surface it lands on', () => {
    const washes = new Set(
      pairs.map((p) => p.bg.split('@')[0]).filter((b) => b?.startsWith('wash.')),
    );
    expect([...washes].sort()).toEqual(
      Object.keys(tokens.docs.wash)
        .map((w) => `wash.${w}`)
        .sort(),
    );
  });

  it('composites a wash over its surface before measuring', () => {
    expect(docsColorOf('wash.accent@surface.ground', 'light')).toBe('#DBDBEF');
    expect(docsColorOf('surface.card', 'dark')).toBe('#232532');
  });

  it('keeps the floors the issue names', () => {
    expect(minimum).toEqual({ text: 4.5, 'non-text': 3 });
  });

  it('pins the tightest pairs, so a palette change is seen in review', () => {
    const tight = pairs
      .map((p) => ({ name: `${p.mode} ${p.fg} on ${p.bg}`, ratio: measureDocs(p, p.mode) }))
      .sort((a, b) => a.ratio - b.ratio)
      .slice(0, 3)
      .map((p) => `${p.name} ${p.ratio}`);
    expect(tight).toMatchInlineSnapshot(`
      [
        "light border.control on surface.sunken 3.1",
        "light border.control on surface.hover 3.1",
        "light border.control on surface.ground 3.33",
      ]
    `);
  });
});

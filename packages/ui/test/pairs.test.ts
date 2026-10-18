import { describe, expect, it } from 'vitest';
import {
  colorOf,
  disabledCeiling,
  disabledPairs,
  expandPairs,
  forbiddenPairs,
  measure,
  minimum,
  requiredPairs,
  ruledOutPairs,
} from '../src/tokens/pairs.ts';

// Every required pair with the ratio it measures today, floored to two decimals. A token change
// that moves a ratio fails here until the table is updated, so the numbers in review are the
// numbers users see. Text needs 4.5:1, marks and control borders need 3:1.
const required = [
  // Light, text
  ['light', 'text.ink', 'surface.ground', 'text', 18.02],
  ['light', 'text.ink', 'surface.raised', 'text', 17.26],
  ['light', 'text.ink', 'surface.sunken', 'text', 17.26],
  ['light', 'text.body', 'surface.ground', 'text', 14.0],
  ['light', 'text.body', 'surface.raised', 'text', 13.4],
  ['light', 'text.body', 'surface.sunken', 'text', 13.4],
  ['light', 'text.secondary', 'surface.ground', 'text', 7.25],
  ['light', 'text.secondary', 'surface.raised', 'text', 6.94],
  ['light', 'text.secondary', 'surface.sunken', 'text', 6.94],
  ['light', 'text.subtle', 'surface.ground', 'text', 4.55],
  ['light', 'accent.ink', 'surface.ground', 'text', 6.02],
  ['light', 'accent.ink', 'surface.raised', 'text', 5.76],
  ['light', 'accent.ink', 'surface.sunken', 'text', 5.76],
  ['light', 'accent.press', 'surface.ground', 'text', 7.56],
  ['light', 'accent.press', 'surface.raised', 'text', 7.24],
  ['light', 'accent.press', 'surface.sunken', 'text', 7.24],
  ['light', 'signal.text', 'surface.ground', 'text', 5.24],
  ['light', 'signal.text', 'surface.raised', 'text', 5.01],
  ['light', 'signal.text', 'surface.sunken', 'text', 5.01],
  ['light', 'state.fresh.text', 'surface.ground', 'text', 4.8],
  ['light', 'state.fresh.text', 'surface.raised', 'text', 4.59],
  ['light', 'state.fresh.text', 'surface.sunken', 'text', 4.59],
  ['light', 'state.stale.text', 'surface.ground', 'text', 4.8],
  ['light', 'state.stale.text', 'surface.raised', 'text', 4.6],
  ['light', 'state.stale.text', 'surface.sunken', 'text', 4.6],
  ['light', 'state.broken.text', 'surface.ground', 'text', 6.19],
  ['light', 'state.broken.text', 'surface.raised', 'text', 5.93],
  ['light', 'state.broken.text', 'surface.sunken', 'text', 5.93],
  ['light', 'state.neutral.text', 'surface.ground', 'text', 7.25],
  ['light', 'state.neutral.text', 'surface.raised', 'text', 6.94],
  ['light', 'state.neutral.text', 'surface.sunken', 'text', 6.94],
  ['light', 'text.ink', 'accent.wash', 'text', 16.05],
  ['light', 'text.body', 'accent.wash', 'text', 12.47],
  ['light', 'text.secondary', 'accent.wash', 'text', 6.46],
  ['light', 'accent.ink', 'accent.wash', 'text', 5.36],
  ['light', 'accent.on', 'accent.ink', 'text', 6.28],
  ['light', 'accent.on', 'accent.press', 'text', 7.9],
  // Light, marks and controls
  ['light', 'border.control', 'surface.ground', 'non-text', 3.3],
  ['light', 'border.control', 'surface.raised', 'non-text', 3.16],
  ['light', 'border.control', 'surface.sunken', 'non-text', 3.16],
  ['light', 'focus.ring', 'surface.ground', 'non-text', 6.02],
  ['light', 'focus.ring', 'surface.raised', 'non-text', 5.76],
  ['light', 'focus.ring', 'surface.sunken', 'non-text', 5.76],
  ['light', 'focus.ring', 'accent.wash', 'non-text', 5.36],
  ['light', 'state.fresh.mark', 'surface.ground', 'non-text', 3.15],
  ['light', 'state.fresh.mark', 'surface.raised', 'non-text', 3.02],
  ['light', 'state.fresh.mark', 'surface.sunken', 'non-text', 3.02],
  ['light', 'state.broken.mark', 'surface.ground', 'non-text', 4.62],
  ['light', 'state.broken.mark', 'surface.raised', 'non-text', 4.42],
  ['light', 'state.broken.mark', 'surface.sunken', 'non-text', 4.42],
  ['light', 'state.neutral.text', 'state.neutral.mark', 'non-text', 5.08],
  // Dark, text
  ['dark', 'text.ink', 'surface.ground', 'text', 17.89],
  ['dark', 'text.ink', 'surface.raised', 'text', 16.62],
  ['dark', 'text.ink', 'surface.sunken', 'text', 15.34],
  ['dark', 'text.body', 'surface.ground', 'text', 12.54],
  ['dark', 'text.body', 'surface.raised', 'text', 11.65],
  ['dark', 'text.body', 'surface.sunken', 'text', 10.75],
  ['dark', 'text.secondary', 'surface.ground', 'text', 7.4],
  ['dark', 'text.secondary', 'surface.raised', 'text', 6.88],
  ['dark', 'text.secondary', 'surface.sunken', 'text', 6.35],
  ['dark', 'text.subtle', 'surface.ground', 'text', 7.4],
  ['dark', 'text.subtle', 'surface.raised', 'text', 6.88],
  ['dark', 'text.subtle', 'surface.sunken', 'text', 6.35],
  ['dark', 'accent.ink', 'surface.ground', 'text', 6.26],
  ['dark', 'accent.ink', 'surface.raised', 'text', 5.82],
  ['dark', 'accent.ink', 'surface.sunken', 'text', 5.37],
  ['dark', 'accent.press', 'surface.ground', 'text', 9.37],
  ['dark', 'accent.press', 'surface.raised', 'text', 8.7],
  ['dark', 'accent.press', 'surface.sunken', 'text', 8.03],
  ['dark', 'signal.text', 'surface.ground', 'text', 7.5],
  ['dark', 'signal.text', 'surface.raised', 'text', 6.97],
  ['dark', 'signal.text', 'surface.sunken', 'text', 6.43],
  ['dark', 'state.fresh.text', 'surface.ground', 'text', 10.72],
  ['dark', 'state.fresh.text', 'surface.raised', 'text', 9.96],
  ['dark', 'state.fresh.text', 'surface.sunken', 'text', 9.19],
  ['dark', 'state.stale.text', 'surface.ground', 'text', 11.19],
  ['dark', 'state.stale.text', 'surface.raised', 'text', 10.4],
  ['dark', 'state.stale.text', 'surface.sunken', 'text', 9.6],
  ['dark', 'state.broken.text', 'surface.ground', 'text', 6.75],
  ['dark', 'state.broken.text', 'surface.raised', 'text', 6.27],
  ['dark', 'state.broken.text', 'surface.sunken', 'text', 5.79],
  ['dark', 'state.neutral.text', 'surface.ground', 'text', 7.4],
  ['dark', 'state.neutral.text', 'surface.raised', 'text', 6.88],
  ['dark', 'state.neutral.text', 'surface.sunken', 'text', 6.35],
  ['dark', 'text.ink', 'accent.wash', 'text', 14.28],
  ['dark', 'text.body', 'accent.wash', 'text', 10.01],
  ['dark', 'text.secondary', 'accent.wash', 'text', 5.91],
  ['dark', 'accent.ink', 'accent.wash', 'text', 5.0],
  ['dark', 'accent.on', 'accent.ink', 'text', 6.26],
  ['dark', 'accent.on', 'accent.press', 'text', 9.37],
  // Dark, marks and controls
  ['dark', 'border.control', 'surface.ground', 'non-text', 3.89],
  ['dark', 'border.control', 'surface.raised', 'non-text', 3.61],
  ['dark', 'border.control', 'surface.sunken', 'non-text', 3.34],
  ['dark', 'focus.ring', 'surface.ground', 'non-text', 6.26],
  ['dark', 'focus.ring', 'surface.raised', 'non-text', 5.82],
  ['dark', 'focus.ring', 'surface.sunken', 'non-text', 5.37],
  ['dark', 'focus.ring', 'accent.wash', 'non-text', 5.0],
  ['dark', 'signal.mark', 'surface.ground', 'non-text', 7.5],
  ['dark', 'signal.mark', 'surface.raised', 'non-text', 6.97],
  ['dark', 'signal.mark', 'surface.sunken', 'non-text', 6.43],
  ['dark', 'state.fresh.mark', 'surface.ground', 'non-text', 10.72],
  ['dark', 'state.fresh.mark', 'surface.raised', 'non-text', 9.96],
  ['dark', 'state.fresh.mark', 'surface.sunken', 'non-text', 9.19],
  ['dark', 'state.stale.mark', 'surface.ground', 'non-text', 11.19],
  ['dark', 'state.stale.mark', 'surface.raised', 'non-text', 10.4],
  ['dark', 'state.stale.mark', 'surface.sunken', 'non-text', 9.6],
  ['dark', 'state.broken.mark', 'surface.ground', 'non-text', 6.75],
  ['dark', 'state.broken.mark', 'surface.raised', 'non-text', 6.27],
  ['dark', 'state.broken.mark', 'surface.sunken', 'non-text', 5.79],
  ['dark', 'state.neutral.text', 'state.neutral.mark', 'non-text', 4.07],
] as const;

// Rules that come out of the numbers. Each must keep failing, so nobody "fixes" the table by
// deleting the rule instead of changing how the colour is used.
const forbidden = [
  // Captions sit on ground only in light.
  ['light', 'text.subtle', 'surface.raised', 'text', 4.36],
  ['light', 'text.subtle', 'surface.sunken', 'text', 4.36],
  // Amber and teal marks never stand alone on paper; they sit beside a word or a tick.
  ['light', 'state.stale.mark', 'surface.ground', 'non-text', 2.05],
  ['light', 'signal.mark', 'surface.ground', 'non-text', 2.38],
  // State words and captions never sit on the selection wash, and selected rows draw their
  // edge from the rule token, not the control border.
  ['light', 'state.fresh.text', 'accent.wash', 'text', 4.27],
  ['light', 'state.stale.text', 'accent.wash', 'text', 4.28],
  ['light', 'text.subtle', 'accent.wash', 'text', 4.05],
  ['light', 'border.control', 'accent.wash', 'non-text', 2.94],
] as const;

// Ruled out by design even where the ratio passes, so the rule reads the same in both modes:
// a selected row shows state with its icon and ink text, never coloured text.
const ruledOut = [
  ['light', 'state.broken.text', 'accent.wash', 'text', 5.51],
  ['light', 'state.neutral.text', 'accent.wash', 'text', 6.46],
  ['dark', 'state.fresh.text', 'accent.wash', 'text', 8.56],
  ['dark', 'state.stale.text', 'accent.wash', 'text', 8.93],
  ['dark', 'state.broken.text', 'accent.wash', 'text', 5.39],
  ['dark', 'state.neutral.text', 'accent.wash', 'text', 5.91],
  ['dark', 'text.subtle', 'accent.wash', 'text', 5.91],
  ['dark', 'border.control', 'accent.wash', 'non-text', 3.11],
] as const;

// Disabled controls are drawn with their own colours, never with opacity, so every value they
// show is measured here. Each sits inside a band: a label above its floor can still be made
// out, and nothing reaches 3:1, so a disabled control never reads as a live one. WCAG exempts
// disabled controls; the band is ours.
const disabled = [
  ['light', 'disabled.text', 'disabled.fill', 'text', 2.35],
  ['light', 'disabled.text', 'surface.ground', 'text', 2.45],
  ['light', 'disabled.text', 'surface.raised', 'text', 2.35],
  ['light', 'disabled.text', 'surface.sunken', 'text', 2.35],
  ['light', 'disabled.edge', 'disabled.fill', 'non-text', 1.36],
  ['light', 'disabled.edge', 'surface.ground', 'non-text', 1.42],
  ['light', 'disabled.edge', 'surface.raised', 'non-text', 1.36],
  ['light', 'disabled.edge', 'surface.sunken', 'non-text', 1.36],
  ['dark', 'disabled.text', 'disabled.fill', 'text', 2.27],
  ['dark', 'disabled.text', 'surface.ground', 'text', 2.44],
  ['dark', 'disabled.text', 'surface.raised', 'text', 2.27],
  ['dark', 'disabled.text', 'surface.sunken', 'text', 2.1],
  ['dark', 'disabled.edge', 'disabled.fill', 'non-text', 1.69],
  ['dark', 'disabled.edge', 'surface.ground', 'non-text', 1.81],
  ['dark', 'disabled.edge', 'surface.raised', 'non-text', 1.69],
  ['dark', 'disabled.edge', 'surface.sunken', 'non-text', 1.56],
] as const;

const key = (row: readonly unknown[]) => row.slice(0, 4).join(' ');

describe('required contrast pairs', () => {
  it.each(required)('%s %s on %s (%s) measures %s', (mode, fg, bg, kind, ratio) => {
    const measured = measure({ fg, bg, kind }, mode);
    expect(measured).toBe(ratio);
    expect(measured).toBeGreaterThanOrEqual(minimum[kind]);
  });

  it('lists exactly the pairs the tokens declare, so none go unmeasured', () => {
    const declared = expandPairs(requiredPairs).map((p) => key([p.mode, p.fg, p.bg, p.kind]));
    expect(new Set(declared).size).toBe(declared.length);
    expect(declared.sort()).toEqual(required.map(key).sort());
  });
});

describe('forbidden contrast pairs', () => {
  it.each(forbidden)('%s %s on %s (%s) still fails at %s', (mode, fg, bg, kind, ratio) => {
    const measured = measure({ fg, bg, kind }, mode);
    expect(measured).toBe(ratio);
    expect(measured).toBeLessThan(minimum[kind]);
  });

  it('lists exactly the forbidden pairs the tokens declare', () => {
    const declared = expandPairs(forbiddenPairs).map((p) => key([p.mode, p.fg, p.bg, p.kind]));
    expect(declared.sort()).toEqual(forbidden.map(key).sort());
  });
});

describe('ruled out pairs', () => {
  it.each(ruledOut)(
    '%s %s on %s (%s) measures %s but is never used',
    (mode, fg, bg, kind, ratio) => {
      expect(measure({ fg, bg, kind }, mode)).toBe(ratio);
    },
  );

  it('lists exactly the ruled out pairs the tokens declare', () => {
    const declared = expandPairs(ruledOutPairs).map((p) => key([p.mode, p.fg, p.bg, p.kind]));
    expect(declared.sort()).toEqual(ruledOut.map(key).sort());
  });

  it('never overlaps the required pairs', () => {
    const required = new Set(expandPairs(requiredPairs).map((p) => key([p.mode, p.fg, p.bg])));
    for (const p of expandPairs([...forbiddenPairs, ...ruledOutPairs, ...disabledPairs])) {
      expect(required.has(key([p.mode, p.fg, p.bg])), key([p.mode, p.fg, p.bg])).toBe(false);
    }
  });
});

describe('disabled pairs', () => {
  const floorOf = (mode: string, fg: string, bg: string) => {
    const group = disabledPairs.find(
      (g) =>
        g.modes.some((m) => m === mode) && g.fg.some((f) => f === fg) && g.bg.some((b) => b === bg),
    );
    if (group === undefined) throw new Error(`${mode} ${fg} on ${bg} is not declared`);
    return group.floor;
  };

  it.each(disabled)(
    '%s %s on %s (%s) measures %s, inside the band',
    (mode, fg, bg, kind, ratio) => {
      const measured = measure({ fg, bg, kind }, mode);
      expect(measured).toBe(ratio);
      expect(measured).toBeGreaterThanOrEqual(floorOf(mode, fg, bg));
      expect(measured).toBeLessThan(disabledCeiling);
    },
  );

  it('lists exactly the disabled pairs the tokens declare', () => {
    const declared = expandPairs(disabledPairs).map((p) => key([p.mode, p.fg, p.bg, p.kind]));
    expect(new Set(declared).size).toBe(declared.length);
    expect(declared.sort()).toEqual(disabled.map(key).sort());
  });

  it('keeps the ceiling at the live floor for marks and control edges', () => {
    expect(disabledCeiling).toBe(minimum['non-text']);
  });

  it('keeps a label floor that can still be made out', () => {
    for (const g of disabledPairs) {
      if (g.kind === 'text') expect(g.floor).toBeGreaterThanOrEqual(2);
    }
  });

  it('reads weaker than the live control it stands in for, on every surface', () => {
    for (const mode of ['light', 'dark'] as const) {
      for (const bg of ['surface.ground', 'surface.raised', 'surface.sunken'] as const) {
        expect(measure({ fg: 'disabled.text', bg }, mode)).toBeLessThan(
          measure({ fg: 'text.secondary', bg }, mode),
        );
        expect(measure({ fg: 'disabled.edge', bg }, mode)).toBeLessThan(
          measure({ fg: 'border.control', bg }, mode),
        );
      }
    }
  });

  it('never appears in a live pair', () => {
    for (const p of expandPairs(requiredPairs)) {
      expect(p.fg.startsWith('disabled.'), key([p.mode, p.fg, p.bg])).toBe(false);
      expect(p.bg.startsWith('disabled.'), key([p.mode, p.fg, p.bg])).toBe(false);
    }
  });
});

describe('colorOf', () => {
  it('composites the wash over the ground of the same mode', () => {
    expect(colorOf('accent.wash', 'light')).toBe('#ECECF7');
    expect(colorOf('accent.wash', 'dark')).toBe('#252635');
  });

  it('reads a role for the mode', () => {
    expect(colorOf('surface.ground', 'dark')).toBe('#141210');
    expect(colorOf('state.broken.text', 'light')).toBe('#B91C1C');
  });
});

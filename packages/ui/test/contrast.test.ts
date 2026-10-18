import { describe, expect, it } from 'vitest';
import { composite, contrast, floor2, luminance } from '../src/tokens/contrast.ts';

describe('luminance', () => {
  it('is 0 for black and 1 for white', () => {
    expect(luminance('#000000')).toBe(0);
    expect(luminance('#FFFFFF')).toBe(1);
  });

  it('accepts lower case and short hex', () => {
    expect(luminance('#fafaf9')).toBe(luminance('#FAFAF9'));
    expect(luminance('#fff')).toBe(1);
  });

  it('rejects anything that is not a hex colour', () => {
    expect(() => luminance('#12345')).toThrow(/not a hex colour/);
    expect(() => luminance('#GGGGGG')).toThrow(/not a hex colour/);
  });
});

describe('contrast', () => {
  it('is 21 for black on white and symmetric', () => {
    expect(contrast('#000000', '#FFFFFF')).toBe(21);
    expect(contrast('#FFFFFF', '#000000')).toBe(21);
  });

  it('matches a published WCAG reference pair', () => {
    // #767676 on white is the classic lightest grey that passes 4.5:1 (4.54).
    expect(floor2(contrast('#767676', '#FFFFFF'))).toBe(4.54);
  });
});

describe('floor2', () => {
  it('never rounds a failure up to a pass', () => {
    expect(floor2(4.4999)).toBe(4.49);
    expect(floor2(2.999)).toBe(2.99);
    expect(floor2(4.5)).toBe(4.5);
  });
});

describe('composite', () => {
  it('mixes a translucent colour over a ground', () => {
    // The light selection wash, indigo at 8 percent over paper.
    expect(composite('#4F46E5', 0.08, '#FAFAF9')).toBe('#ECECF7');
    expect(composite('#818CF8', 0.16, '#141210')).toBe('#252635');
  });

  it('returns the ground at 0 and the colour at 1', () => {
    expect(composite('#4F46E5', 0, '#FAFAF9')).toBe('#FAFAF9');
    expect(composite('#4F46E5', 1, '#FAFAF9')).toBe('#4F46E5');
  });
});

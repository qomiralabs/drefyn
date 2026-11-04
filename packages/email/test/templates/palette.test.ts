import { contrast, floor2 } from '@drefyn/ui';
import { describe, expect, it } from 'vitest';
import { MAIL_PALETTE, MAIL_TEXT_ROLES } from '../../src/html/palette.ts';

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb: readonly number[]) =>
  `#${rgb
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, '0')
        .toUpperCase(),
    )
    .join('')}`;

const invertPlain = (hex: string) => toHex(channels(hex).map((v) => 255 - v));

// The CSS hue-rotate(180deg) matrix in sRGB, the usual stand in for the way the Gmail apps
// flip lightness and keep hue.
const HUE_180 = [
  [-0.574, 1.43, 0.144],
  [0.426, 0.43, 0.144],
  [0.426, 1.43, -0.856],
] as const;

function invertKeepingHue(hex: string): string {
  const v = channels(invertPlain(hex));
  return toHex(HUE_180.map((row) => row.reduce((sum, w, i) => sum + w * (v[i] ?? 0), 0)));
}

const AA = 4.5;

describe('mail palette', () => {
  it('uses text roles that exist and no status colour', () => {
    expect([...MAIL_TEXT_ROLES]).toEqual(['ink', 'body', 'secondary', 'accent']);
  });

  it.each(MAIL_TEXT_ROLES)('%s clears 4.5:1 in light, dark and both inversions', (role) => {
    const light = MAIL_PALETTE.light;
    const dark = MAIL_PALETTE.dark;
    expect(floor2(contrast(light[role], light.ground))).toBeGreaterThanOrEqual(AA);
    expect(floor2(contrast(dark[role], dark.ground))).toBeGreaterThanOrEqual(AA);
    expect(
      floor2(contrast(invertPlain(light[role]), invertPlain(light.ground))),
    ).toBeGreaterThanOrEqual(AA);
    expect(
      floor2(contrast(invertKeepingHue(light[role]), invertKeepingHue(light.ground))),
    ).toBeGreaterThanOrEqual(AA);
    // A client that keeps our dark palette but puts its own darker ground under it.
    expect(floor2(contrast(dark[role], invertKeepingHue(light.ground)))).toBeGreaterThanOrEqual(AA);
  });

  it('matches the inversion colours sampled from a real rendered filter', () => {
    expect(invertKeepingHue('#FAFAF9')).toBe('#050504');
    expect(invertKeepingHue('#0B1120')).toBe('#E8EEFD');
    expect(invertKeepingHue('#4F46E5')).toBe('#A79EFF');
  });

  it('keeps the token values for ground and ink', () => {
    expect(MAIL_PALETTE.light.ground).toBe('#FAFAF9');
    expect(MAIL_PALETTE.dark.ground).toBe('#141210');
  });
});

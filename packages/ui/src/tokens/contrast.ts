// WCAG 2.x contrast. The same functions back the CI contrast tests and, later, the check that
// refuses a customer theme on save, so both agree on every number.

import type { Hex } from './tokens.ts';

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function channels(hex: string): [number, number, number] {
  const match = HEX.exec(hex);
  if (match?.[1] === undefined) throw new Error(`${hex} is not a hex colour`);
  const short = match[1];
  const digits = short.length === 3 ? short.replace(/./g, (d) => d + d) : short;
  return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)) as [number, number, number];
}

function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: Hex): number {
  const [r, g, b] = channels(hex).map(linear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: Hex, b: Hex): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// Floor, not round: a printed 4.50 must never hide a 4.499.
export function floor2(ratio: number): number {
  return Math.floor(ratio * 100) / 100;
}

// The opaque colour a translucent one shows as over a ground.
export function composite(color: Hex, alpha: number, over: Hex): Hex {
  const fg = channels(color);
  const bg = channels(over);
  const mixed = fg.map((c, i) => Math.round(c * alpha + (bg[i] ?? 0) * (1 - alpha)));
  return `#${mixed.map((c) => c.toString(16).padStart(2, '0').toUpperCase()).join('')}`;
}

import type { Scale } from './types.ts';

const INT8_MIN = -(2n ** 63n);
const INT8_MAX = 2n ** 63n - 1n;

const DECIMAL = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

// The longest int8 is 19 digits, plus a sign, a point and six places. Length is checked
// first because BigInt is not linear in its input.
const MAX_DECIMAL_LENGTH = 27;

// Integer units, or null. Digits past the scale are refused rather than rounded, since
// rounding would quietly store a different number than the one sent.
export function parseUnits(value: string, scale: Scale): bigint | null {
  if (value.length > MAX_DECIMAL_LENGTH) return null;
  const match = DECIMAL.exec(value);
  if (match === null) return null;
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > scale) return null;
  const digits = BigInt(`${whole ?? '0'}${fraction.padEnd(scale, '0')}`);
  const units = sign === '-' ? -digits : digits;
  return units >= INT8_MIN && units <= INT8_MAX ? units : null;
}

export function formatUnits(units: bigint, scale: Scale): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = scale === 0 ? '' : `.${digits.slice(digits.length - scale)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

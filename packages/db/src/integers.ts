import { DbError } from './errors.ts';

export interface SafeIntegerOptions {
  readonly allowNegative?: boolean;
}

// Canonical decimal text only: no plus sign, no leading zeros, no exponent, no spaces, and
// no negative zero, so a string is accepted only when it is exactly how the number prints.
const DECIMAL = /^(?:0|-?[1-9][0-9]*)$/;
const MAX = BigInt(Number.MAX_SAFE_INTEGER);

function candidate(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return value >= -MAX && value <= MAX ? Number(value) : undefined;
  if (typeof value === 'string' && DECIMAL.test(value)) return Number(value);
  return undefined;
}

// Accepts a safe integer number, a bigint in the safe range or a canonical decimal string.
// Throws DbError INTEGER_INVALID naming the field, never the value.
export function toSafeInteger(value: unknown, field: string, options?: SafeIntegerOptions): number {
  const allowNegative = options?.allowNegative === true;
  const n = candidate(value);
  if (n === undefined || !Number.isSafeInteger(n) || (n < 0 && !allowNegative)) {
    const range = allowNegative ? 'a safe integer' : 'a safe integer of zero or more';
    throw new DbError('INTEGER_INVALID', `${field} must be ${range}`);
  }
  // Number.isSafeInteger(-0) is true; the database has no negative zero.
  return n === 0 ? 0 : n;
}

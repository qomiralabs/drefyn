import { notImplemented } from './not-implemented.ts';

export interface SafeIntegerOptions {
  readonly allowNegative?: boolean;
}

// Accepts a safe integer number, a bigint in the safe range or a canonical decimal string.
// Throws DbError INTEGER_INVALID naming the field, never the value.
export function toSafeInteger(value: unknown, field: string, options?: SafeIntegerOptions): number {
  return notImplemented(`toSafeInteger(${typeof value}, ${field}, ${typeof options})`);
}

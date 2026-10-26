import { CreditError } from './errors.ts';

// Not exported, so the only way to hold Credits is through credits().
declare const creditsBrand: unique symbol;

export type Credits = number & { readonly [creditsBrand]: true };

// Accepts only number primitives: a bigint, a boxed number or a numeric string would each
// need a conversion, and a silent conversion is how a fraction or overflow slips in.
export function credits(value: unknown): Credits {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new CreditError('CREDIT_AMOUNT_INVALID');
  }
  // -0 passes the checks above; folding it keeps one spelling of zero.
  return (value === 0 ? 0 : value) as Credits;
}

// An entry that moves nothing is a caller bug, so entry amounts start at one.
export function entryAmount(value: unknown): Credits {
  const amount = credits(value);
  if (amount === 0) throw new CreditError('CREDIT_AMOUNT_INVALID');
  return amount;
}

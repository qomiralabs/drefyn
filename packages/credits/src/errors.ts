export type CreditErrorCode =
  | 'CREDIT_AMOUNT_INVALID'
  | 'CREDIT_KEY_INVALID'
  | 'CREDIT_REASON_INVALID'
  | 'CREDIT_ORGANIZATION_INVALID'
  | 'CREDIT_IDEMPOTENCY_CONFLICT'
  | 'CREDIT_ENTRY_NOT_FOUND'
  | 'CREDIT_NOT_REVERSIBLE'
  | 'CREDIT_BALANCE_OVERFLOW';

// Fixed text per code. Rejected values come from callers, can be huge, and keys may hold job
// identifiers, so none of it belongs in a message that ends up in logs.
const MESSAGES: Readonly<Record<CreditErrorCode, string>> = {
  CREDIT_AMOUNT_INVALID:
    'credit amount must be a non negative safe integer, and not zero on an entry',
  CREDIT_KEY_INVALID:
    'idempotency key must be an own string of 1 to 200 well formed code points without NUL',
  CREDIT_REASON_INVALID: 'spend reason is not one of SPEND_REASONS',
  CREDIT_ORGANIZATION_INVALID: 'organization ref must carry an own canonical organization id',
  CREDIT_IDEMPOTENCY_CONFLICT: 'idempotency key was already used with a different request',
  CREDIT_ENTRY_NOT_FOUND: 'credit entry not found in this organization',
  CREDIT_NOT_REVERSIBLE: 'credit entry is not a spend, or was already reversed',
  CREDIT_BALANCE_OVERFLOW: 'credit balance would exceed the safe integer range',
};

export class CreditError extends Error {
  override readonly name = 'CreditError';
  readonly code: CreditErrorCode;

  constructor(code: CreditErrorCode) {
    super(MESSAGES[code]);
    this.code = code;
  }
}

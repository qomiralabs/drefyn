export const BILLING_ERROR_CODES = Object.freeze([
  'billing.unavailable',
  'billing.forbidden',
  'billing.invalid_input',
  'billing.same_plan',
  'billing.pending_change_exists',
  'billing.contract_plan',
  'billing.keep_over_limit',
  'billing.tax_id_invalid',
  'billing.idempotency_conflict',
] as const);

export type BillingErrorCode = (typeof BILLING_ERROR_CODES)[number];

export const BILLING_ERROR_STATUS: Readonly<Record<BillingErrorCode, number>> = Object.freeze({
  'billing.unavailable': 503,
  'billing.forbidden': 403,
  'billing.invalid_input': 422,
  'billing.same_plan': 409,
  'billing.pending_change_exists': 409,
  'billing.contract_plan': 409,
  'billing.keep_over_limit': 422,
  'billing.tax_id_invalid': 422,
  'billing.idempotency_conflict': 409,
});

// The message is for a person reading the page, such as why a tax id was refused. Pages
// branch on the code, never on the message.
export class BillingError extends Error {
  readonly code: BillingErrorCode;

  constructor(code: BillingErrorCode, message: string = code, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BillingError';
    this.code = code;
  }
}

export function isBillingError(value: unknown): value is BillingError {
  return value instanceof BillingError;
}

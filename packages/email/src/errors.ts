import type { EmailError, EmailErrorCode } from './types.ts';

// Whether the same send could work later. A caller never retries at once; the person
// asks again, so this only shapes what the app tells them.
const RETRYABLE: Readonly<Record<EmailErrorCode, boolean>> = {
  'email.not_configured': false,
  'email.input_invalid': false,
  'email.render_failed': false,
  'email.connect_failed': true,
  'email.tls_failed': false,
  'email.auth_failed': false,
  'email.timeout': true,
  'email.deferred': true,
  'email.rejected': false,
  'email.unknown_outcome': false,
  'email.overloaded': true,
  'email.unavailable': true,
};

export function emailError(
  code: EmailErrorCode,
  extra: { readonly field?: string; readonly smtpReplyClass?: 4 | 5 } = {},
): EmailError {
  return Object.freeze({ code, retryable: RETRYABLE[code], ...extra });
}

export function invalidInput(field: string): EmailError {
  return emailError('email.input_invalid', { field });
}

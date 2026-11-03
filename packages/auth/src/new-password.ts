import { askBreached, type BreachedPasswordCheck } from './breach-check.ts';
import { AuthError } from './errors.ts';
import { checkNewPassword } from './password-input.ts';
import type { PasswordContext } from './password-rules.ts';
import type { AuthLogger, AuthMetrics } from './rate-limiter.ts';

export interface AdmitDeps {
  readonly check?: BreachedPasswordCheck | undefined;
  readonly logger: AuthLogger;
  readonly metrics?: AuthMetrics | undefined;
  // Ids for the log line when the check cannot answer.
  readonly fields: Readonly<Record<string, string>>;
}

export type Admitted = { readonly ok: true } | { readonly ok: false; readonly error: AuthError };

// The one step every new password takes, whether set, changed or reset, so none of them can
// skip the list. Rules first: they are free, and a weak password never reaches the check.
export async function admitNewPassword(
  password: string,
  context: PasswordContext,
  deps: AdmitDeps,
): Promise<Admitted> {
  const rules = checkNewPassword(password, context);
  if (rules.length > 0) return { ok: false, error: new AuthError('AUTH_PASSWORD_WEAK', { rules }) };
  if (await askBreached(deps.check, password, deps)) {
    return { ok: false, error: new AuthError('AUTH_PASSWORD_BREACHED') };
  }
  return { ok: true };
}

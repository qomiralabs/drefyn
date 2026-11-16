import type { StepUpMethod } from './session-support.ts';

// How fresh a step up must be to start or confirm an enrolment. Shorter than the recent
// auth window, because enrolling ends every other session and keeps the recovery codes.
export const ENROLMENT_STEP_UP_MINUTES = 5;
// How old a password must be before stepping up with it counts for enrolment. A session
// can set or change its own password with recent auth alone, so a younger password may be
// the thief's own proof.
export const SETTLED_PASSWORD_HOURS = 24;
// A pending secret is good for this long after it was sealed.
export const PENDING_ENROLMENT_MINUTES = 15;

const KNOWN: ReadonlySet<string> = new Set<StepUpMethod>([
  'email',
  'password',
  'google',
  'github_session',
  'totp',
  'recovery_code',
]);

export interface EnrolmentStepUp {
  // The session's step_up_method as stored, null when it never stepped up.
  readonly method: string | null;
  // authenticated_at within the enrolment window, by database time.
  readonly fresh: boolean;
  // The password hash is at least a day old; null when there is no password.
  readonly passwordSettled: boolean | null;
}

// A plain sign in is not a step up, so a cookie stolen just after one proves nothing here.
// Email and provider step ups prove something the session does not hold by itself, whatever
// the password's age.
export function enrolmentStepUpPasses(proof: EnrolmentStepUp): boolean {
  if (!proof.fresh || proof.method === null || !KNOWN.has(proof.method)) return false;
  return proof.method !== 'password' || proof.passwordSettled === true;
}

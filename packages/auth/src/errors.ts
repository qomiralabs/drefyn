import type { AuthConfigKey } from './config-keys.ts';

export type AuthErrorCode =
  | 'AUTH_CONFIG_INVALID'
  | 'AUTH_INPUT_INVALID'
  | 'AUTH_RATE_LIMITED'
  | 'AUTH_UNAVAILABLE'
  | 'AUTH_CODE_INVALID'
  | 'AUTH_CHALLENGE_EXPIRED'
  | 'AUTH_CHALLENGE_BINDING'
  | 'AUTH_SIGNUP_CLOSED'
  | 'AUTH_OAUTH_STATE_INVALID'
  | 'AUTH_OAUTH_PROVIDER_ERROR'
  | 'AUTH_OAUTH_EMAIL_UNVERIFIED'
  | 'AUTH_OAUTH_DISABLED'
  | 'AUTH_SESSION_INVALID'
  | 'AUTH_RECENT_AUTH_REQUIRED'
  | 'AUTH_FORBIDDEN'
  | 'AUTH_NOT_FOUND'
  | 'AUTH_API_KEY_INVALID'
  | 'AUTH_API_KEY_SCOPE'
  | 'AUTH_IDEMPOTENCY_REPLAY'
  | 'AUTH_SEAT_LIMIT'
  | 'AUTH_LAST_OWNER'
  | 'AUTH_ALREADY_MEMBER'
  | 'AUTH_INVITATION_INVALID'
  | 'AUTH_INVITATION_EMAIL_MISMATCH'
  | 'AUTH_SLUG_INVALID'
  | 'AUTH_SLUG_TAKEN'
  | 'AUTH_CREDENTIALS_INVALID'
  | 'AUTH_PASSWORD_WEAK'
  | 'AUTH_PASSWORD_BREACHED'
  | 'AUTH_PASSWORDS_DISABLED'
  | 'AUTH_BOT_CHECK_REQUIRED'
  | 'AUTH_ORIGIN_REFUSED'
  | 'AUTH_STEP_UP_IDENTITY_MISMATCH';

// Fixed text per code. Callers pass untrusted values and secrets around this class, so
// nothing they hand in ever becomes part of a message.
const MESSAGES: Readonly<Record<AuthErrorCode, string>> = {
  AUTH_CONFIG_INVALID: 'auth config is invalid',
  AUTH_INPUT_INVALID: 'input is not in the expected form',
  AUTH_RATE_LIMITED: 'too many attempts, try again later',
  AUTH_UNAVAILABLE: 'auth is unavailable, try again later',
  AUTH_CODE_INVALID: 'code is not valid',
  AUTH_CHALLENGE_EXPIRED: 'challenge has expired',
  AUTH_CHALLENGE_BINDING: 'challenge belongs to another browser',
  AUTH_SIGNUP_CLOSED: 'sign up is closed',
  AUTH_OAUTH_STATE_INVALID: 'OAuth state is not valid',
  AUTH_OAUTH_PROVIDER_ERROR: 'OAuth provider failed',
  AUTH_OAUTH_EMAIL_UNVERIFIED: 'OAuth address is not verified',
  AUTH_OAUTH_DISABLED: 'OAuth provider is not configured',
  AUTH_SESSION_INVALID: 'session is not valid',
  AUTH_RECENT_AUTH_REQUIRED: 'a recent sign in is required',
  AUTH_FORBIDDEN: 'not allowed',
  AUTH_NOT_FOUND: 'not found',
  AUTH_API_KEY_INVALID: 'API key is not valid',
  AUTH_API_KEY_SCOPE: 'API key lacks the scope',
  AUTH_IDEMPOTENCY_REPLAY: 'request was already made',
  AUTH_SEAT_LIMIT: 'seat limit reached',
  AUTH_LAST_OWNER: 'an organization needs an owner',
  AUTH_ALREADY_MEMBER: 'already a member',
  AUTH_INVITATION_INVALID: 'invitation is not valid',
  AUTH_INVITATION_EMAIL_MISMATCH: 'invitation is for another address',
  AUTH_SLUG_INVALID: 'organization URL name is not valid',
  AUTH_SLUG_TAKEN: 'organization URL name is taken',
  AUTH_CREDENTIALS_INVALID: 'address and password do not match',
  AUTH_PASSWORD_WEAK: 'password is too weak',
  AUTH_PASSWORD_BREACHED: 'password is known to be breached',
  AUTH_PASSWORDS_DISABLED: 'passwords are turned off',
  AUTH_BOT_CHECK_REQUIRED: 'a bot check is required',
  AUTH_ORIGIN_REFUSED: 'request origin refused',
  AUTH_STEP_UP_IDENTITY_MISMATCH: 'step up identity does not belong to this user',
};

export interface AuthErrorDetail {
  readonly key?: AuthConfigKey;
  // Fixed text written in this package; never a value from config or a request.
  readonly reason?: string;
  readonly retryAfterSeconds?: number;
  // The failure underneath, for the server log; never part of the message.
  readonly cause?: unknown;
}

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  declare readonly key?: AuthConfigKey;
  declare readonly retryAfterSeconds?: number;

  constructor(code: AuthErrorCode, detail: AuthErrorDetail = {}) {
    const text =
      detail.key === undefined ? MESSAGES[code] : `${detail.key} ${detail.reason ?? 'is invalid'}`;
    super(`${code}: ${text}`, detail.cause === undefined ? undefined : { cause: detail.cause });
    this.code = code;
    if (detail.key !== undefined) this.key = detail.key;
    if (detail.retryAfterSeconds !== undefined) this.retryAfterSeconds = detail.retryAfterSeconds;
  }
}

// On the prototype, so serialising an error shows only code and key.
Object.defineProperty(AuthError.prototype, 'name', { value: 'AuthError', enumerable: false });

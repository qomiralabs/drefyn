import { describe, expect, it } from 'vitest';
import { AuthError, type AuthErrorCode } from '../src/index.ts';

describe('second factor error codes', () => {
  it('each has fixed text and carries nothing else', () => {
    const codes: readonly [AuthErrorCode, string][] = [
      ['AUTH_FACTOR_REQUIRED', 'the second factor is required'],
      ['AUTH_FACTOR_INVALID', 'code is not valid'],
      ['AUTH_FACTOR_CHALLENGE_EXPIRED', 'sign in has expired, start again'],
      ['AUTH_FACTOR_NOT_ENROLLED', 'no second factor is set up'],
      ['AUTH_FACTOR_ALREADY_ENROLLED', 'a second factor is already set up'],
      ['AUTH_FACTOR_DISABLED', 'authenticator codes are locked, use a recovery code'],
    ];
    for (const [code, text] of codes) {
      const error = new AuthError(code);
      expect(error.message).toBe(`${code}: ${text}`);
      expect(Object.keys(error)).toEqual(['code']);
    }
  });

  // One answer for a wrong, replayed, used or malformed code of either kind, so the page
  // is no oracle for which of them it was.
  it('uses one message for a bad code of either kind', () => {
    expect(new AuthError('AUTH_FACTOR_INVALID').message).not.toMatch(/totp|recovery|replay|used/i);
  });
});

import { describe, expect, it } from 'vitest';
import { AuthError } from '../src/index.ts';

describe('AuthError', () => {
  it('carries a code, fixed text and an optional retry delay', () => {
    const error = new AuthError('AUTH_RATE_LIMITED', { retryAfterSeconds: 30 });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AuthError');
    expect(error.code).toBe('AUTH_RATE_LIMITED');
    expect(error.retryAfterSeconds).toBe(30);
    expect(error.message).toBe('AUTH_RATE_LIMITED: too many attempts, try again later');
    expect(Object.keys(error).sort()).toEqual(['code', 'retryAfterSeconds']);
  });

  it('names the config key and the reason, and nothing else', () => {
    const error = new AuthError('AUTH_CONFIG_INVALID', {
      key: 'DREFYN_AUTH_SECRET',
      reason: 'must be at least 32 bytes',
    });
    expect(error.message).toBe('AUTH_CONFIG_INVALID: DREFYN_AUTH_SECRET must be at least 32 bytes');
    expect(error.key).toBe('DREFYN_AUTH_SECRET');
    expect(new AuthError('AUTH_INPUT_INVALID').message).toBe(
      'AUTH_INPUT_INVALID: input is not in the expected form',
    );
  });
});

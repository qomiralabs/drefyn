import { AuthError, apiKeyErrorResponse, type AuthErrorCode } from '@drefyn/auth';
import { describe, expect, it } from 'vitest';
import {
  API_ERROR_CODES,
  ApiError,
  apiErrorFromAuth,
  errorBody,
  errorResponse,
} from '../src/errors.ts';

const KEY_CODES: readonly AuthErrorCode[] = [
  'AUTH_API_KEY_INVALID',
  'AUTH_API_KEY_SCOPE',
  'AUTH_RATE_LIMITED',
  'AUTH_UNAVAILABLE',
  'AUTH_INPUT_INVALID',
  'AUTH_CONFIG_INVALID',
  'AUTH_FORBIDDEN',
];

describe('error mapping', () => {
  it('gives every code one body with a code and a fixed message', async () => {
    for (const code of API_ERROR_CODES) {
      const response = errorResponse(new ApiError(code));
      const body: unknown = await response.json();
      expect(body).toEqual(errorBody(code));
      expect(Object.keys((body as { error: object }).error).sort()).toEqual(['code', 'message']);
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('maps codes to their statuses', () => {
    const statuses = Object.fromEntries(API_ERROR_CODES.map((c) => [c, new ApiError(c).status]));
    expect(statuses).toEqual({
      'auth.api_key_invalid': 401,
      'auth.api_key_scope': 403,
      'auth.rate_limited': 429,
      'auth.unavailable': 503,
      'api.not_found': 404,
      'api.not_entitled': 403,
      'api.method_not_allowed': 405,
      'api.too_large': 413,
      'api.limit_reached': 429,
      'api.unavailable': 503,
      'api.internal': 500,
    });
  });

  it('sends Retry-After on 429 and 503 only, rounded up and at least one second', () => {
    const limited = errorResponse(new ApiError('auth.rate_limited', { retryAfterSeconds: 2.2 }));
    expect(limited.headers.get('retry-after')).toBe('3');
    const zero = errorResponse(new ApiError('api.limit_reached', { retryAfterSeconds: 0 }));
    expect(zero.headers.get('retry-after')).toBe('1');
    expect(errorResponse(new ApiError('api.unavailable')).headers.get('retry-after')).toBe('1');
    expect(errorResponse(new ApiError('api.not_found')).headers.get('retry-after')).toBeNull();
  });

  // Keys already answer with these through apiKeyErrorResponse; this service must agree.
  it('answers a key refusal with the status and code auth gives it', async () => {
    for (const code of KEY_CODES) {
      const error =
        code === 'AUTH_RATE_LIMITED'
          ? new AuthError(code, { retryAfterSeconds: 7 })
          : new AuthError(code);
      const ours = errorResponse(apiErrorFromAuth(error));
      const theirs = apiKeyErrorResponse(error);
      expect(ours.status, code).toBe(theirs.status);
      const body = (await ours.json()) as { error: { code: string } };
      expect(body.error.code, code).toBe(
        (JSON.parse(theirs.body) as { error: { code: string } }).error.code,
      );
      // A 503 here also says when to come back, which auth's answer leaves out.
      if (theirs.status !== 503) {
        expect(ours.headers.get('retry-after'), code).toBe(theirs.headers['retry-after'] ?? null);
      }
    }
  });

  it('reads anything that is not an AuthError as unavailable', () => {
    expect(apiErrorFromAuth(new Error('boom')).code).toBe('auth.unavailable');
    expect(apiErrorFromAuth('text').code).toBe('auth.unavailable');
  });

  it('keeps a rate limit without a wait at one second', () => {
    const error = apiErrorFromAuth(new AuthError('AUTH_RATE_LIMITED'));
    expect(error.retryAfterSeconds).toBeUndefined();
    expect(errorResponse(error).headers.get('retry-after')).toBe('1');
  });

  it('names itself ApiError and carries only the code as its message', () => {
    const error = new ApiError('api.not_found');
    expect(error.name).toBe('ApiError');
    expect(error.message).toBe('api.not_found');
  });
});

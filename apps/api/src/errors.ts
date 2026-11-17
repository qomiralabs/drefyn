import { AuthError } from '@drefyn/auth';

// The codes clients match on. Additive only. The key refusals keep the auth.* codes keys
// already answer with, so a client written against them never sees a second spelling.
export type ApiErrorCode =
  | 'auth.api_key_invalid'
  | 'auth.api_key_scope'
  | 'auth.rate_limited'
  | 'auth.unavailable'
  | 'api.not_found'
  | 'api.not_entitled'
  | 'api.method_not_allowed'
  | 'api.too_large'
  | 'api.limit_reached'
  | 'api.unavailable'
  | 'api.internal';

export type ApiErrorStatus = 401 | 403 | 404 | 405 | 413 | 429 | 500 | 503;

interface CodeInfo {
  readonly status: ApiErrorStatus;
  // Fixed text. Nothing from a request or a failure underneath ever reaches a message.
  readonly message: string;
}

const CODES: Readonly<Record<ApiErrorCode, CodeInfo>> = {
  'auth.api_key_invalid': { status: 401, message: 'The API key is missing or not valid.' },
  'auth.api_key_scope': { status: 403, message: 'The API key does not allow this request.' },
  'auth.rate_limited': { status: 429, message: 'Too many failed requests. Try again later.' },
  'auth.unavailable': { status: 503, message: 'Keys cannot be checked right now. Try again.' },
  'api.not_found': { status: 404, message: 'Not found.' },
  'api.not_entitled': { status: 403, message: 'The plan does not include this feature.' },
  'api.method_not_allowed': { status: 405, message: 'This method is not allowed here.' },
  'api.too_large': { status: 413, message: 'The request body is too large.' },
  'api.limit_reached': { status: 429, message: 'The plan limit for this request is reached.' },
  'api.unavailable': { status: 503, message: 'The service is unavailable. Try again.' },
  'api.internal': { status: 500, message: 'Something went wrong on our side.' },
};

export const API_ERROR_CODES: readonly ApiErrorCode[] = Object.freeze(
  Object.keys(CODES) as ApiErrorCode[],
);

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: ApiErrorStatus;
  declare readonly retryAfterSeconds?: number;

  constructor(code: ApiErrorCode, detail: { readonly retryAfterSeconds?: number } = {}) {
    super(code);
    this.code = code;
    this.status = CODES[code].status;
    if (detail.retryAfterSeconds !== undefined) this.retryAfterSeconds = detail.retryAfterSeconds;
  }
}
Object.defineProperty(ApiError.prototype, 'name', { value: 'ApiError', enumerable: false });

export interface ApiErrorBody {
  readonly error: { readonly code: ApiErrorCode; readonly message: string };
}

export function errorBody(code: ApiErrorCode): ApiErrorBody {
  return { error: { code, message: CODES[code].message } };
}

// Every refusal leaves through here, so all of them share one body and the same headers.
export function errorResponse(error: ApiError): Response {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  };
  if (error.status === 429 || error.status === 503) {
    const seconds = error.retryAfterSeconds ?? 1;
    headers['retry-after'] = String(Math.max(1, Math.ceil(seconds)));
  }
  return new Response(JSON.stringify(errorBody(error.code)), { status: error.status, headers });
}

// The same answers apiKeyErrorResponse gives, in this service's body.
export function apiErrorFromAuth(error: unknown): ApiError {
  if (!(error instanceof AuthError)) return new ApiError('auth.unavailable');
  switch (error.code) {
    case 'AUTH_API_KEY_SCOPE':
      return new ApiError('auth.api_key_scope');
    case 'AUTH_RATE_LIMITED':
      return new ApiError(
        'auth.rate_limited',
        error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds },
      );
    case 'AUTH_UNAVAILABLE':
      return new ApiError('auth.unavailable');
    default:
      return new ApiError('auth.api_key_invalid');
  }
}

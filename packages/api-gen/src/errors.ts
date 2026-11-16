import type { FilterErrorCode } from '@drefyn/schema';
import type { FieldIssueCode } from './types.ts';

// Every error code a /v1 content route can answer with, REST and GraphQL alike. Adding one is
// additive; removing or renaming one breaks clients.
export const CONTENT_ERROR_CODES = Object.freeze([
  'api.filter_invalid',
  'api.forbidden',
  'api.idempotency_conflict',
  'api.limit_reached',
  'api.not_found',
  'api.rate_limited',
  'api.too_large',
  'api.unauthorized',
  'api.unavailable',
  'api.validation_failed',
  'api.version_conflict',
] as const);
export type ContentErrorCode = (typeof CONTENT_ERROR_CODES)[number];

// Refusals only GraphQL can give, because only GraphQL lets a client shape the work, plus the
// catch all that the REST service also answers with.
export const GRAPHQL_ERROR_CODES = Object.freeze([
  'api.query_invalid',
  'api.query_too_deep',
  'api.query_too_complex',
  'api.introspection_disabled',
  'api.internal',
] as const);
export type GraphqlErrorCode = (typeof GRAPHQL_ERROR_CODES)[number];

export type ApiFieldCode = FieldIssueCode | FilterErrorCode;

export interface ApiFieldError {
  readonly path: string;
  readonly code: ApiFieldCode;
}

// Fixed text. Nothing a client sent and nothing from a failure underneath reaches a message.
export const ERROR_MESSAGES: Readonly<Record<ContentErrorCode | GraphqlErrorCode, string>> = {
  'api.filter_invalid': 'The filter is not valid.',
  'api.forbidden': 'The API key does not allow this request.',
  'api.idempotency_conflict': 'The idempotency key was used with a different request.',
  'api.limit_reached': 'The plan limit for this request is reached.',
  'api.not_found': 'Not found.',
  'api.rate_limited': 'Too many requests. Try again later.',
  'api.too_large': 'The request is too large.',
  'api.unauthorized': 'The API key is missing or not valid.',
  'api.unavailable': 'The service is unavailable. Try again.',
  'api.validation_failed': 'The content is not valid.',
  'api.version_conflict': 'The item changed since it was read.',
  'api.query_invalid': 'The query is not valid.',
  'api.query_too_deep': 'The query is nested too deeply.',
  'api.query_too_complex': 'The query asks for too much at once.',
  'api.introspection_disabled': 'Introspection is turned off for this project.',
  'api.internal': 'Something went wrong on our side.',
};

// What a resolver throws to answer with a REST code. GraphQL puts the same code, and the same
// field list, in the error's extensions.
export class ContentApiError extends Error {
  readonly code: ContentErrorCode | GraphqlErrorCode;
  readonly fields: readonly ApiFieldError[] | undefined;

  constructor(code: ContentErrorCode | GraphqlErrorCode, fields?: readonly ApiFieldError[]) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
    this.fields = fields;
  }
}
Object.defineProperty(ContentApiError.prototype, 'name', {
  value: 'ContentApiError',
  enumerable: false,
});

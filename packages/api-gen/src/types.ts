import type { MdxRoot } from '@drefyn/mdx';
import type { FilterErrorCode } from '@drefyn/schema';

export const FIELD_ISSUE_CODES = Object.freeze([
  'field.required',
  'field.unknown',
  'field.type',
  'field.too_long',
  'field.too_many',
  'field.number',
  'field.range',
  'field.date',
  'field.format',
  'field.text',
  'field.rich_text',
] as const);
export type FieldIssueCode = (typeof FIELD_ISSUE_CODES)[number];

// Paths are API names and positions. An issue reaches clients and logs, so it never carries
// a value the client sent.
export interface FieldIssue {
  readonly path: string;
  readonly code: FieldIssueCode;
}

export type ContentValue =
  | string
  | boolean
  | MdxRoot
  | readonly ContentValue[]
  | { readonly [fieldId: string]: ContentValue };

// Keyed by field id, keys in sorted order, so the same content always serializes the same.
export type ContentFields = Readonly<Record<string, ContentValue>>;

export type Validator = (
  input: unknown,
) =>
  | { readonly ok: true; readonly value: ContentFields }
  | { readonly ok: false; readonly error: readonly FieldIssue[] };

export interface FilterParamError {
  readonly code: 'api.filter_invalid';
  readonly fields: readonly { readonly path: string; readonly code: FilterErrorCode }[];
}

export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface OpenApiOptions {
  // Written into servers; the operator's public API origin.
  readonly serverUrl: string;
  readonly title: string;
  // The project's schema version, so a client can tell two documents apart.
  readonly schemaVersion: number;
}

export interface OpenApiDocument {
  readonly openapi: '3.1.0';
  readonly [key: string]: JsonValue;
}

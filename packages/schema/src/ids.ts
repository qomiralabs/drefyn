import type { FieldId, TypeId } from './types.ts';

// Lowercase only: two spellings of one id would be two fields to every Set and Map here.
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && CANONICAL_UUID.test(value);

export const asFieldId = (value: string): FieldId | undefined =>
  isUuid(value) ? (value as FieldId) : undefined;

export const asTypeId = (value: string): TypeId | undefined =>
  isUuid(value) ? (value as TypeId) : undefined;

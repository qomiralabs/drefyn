import type { SchemaErrorCode } from './types.ts';

const API_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const RESERVED: ReadonlySet<string> = new Set([
  // GraphQL scalars and root types.
  'String',
  'Int',
  'Float',
  'Boolean',
  'ID',
  'Query',
  'Mutation',
  'Subscription',
  // Not valid as enum values.
  'true',
  'false',
  'null',
  // A name becomes a key on plain objects in generated code and in consumers. These read
  // an inherited member when the key is absent.
  'constructor',
  'prototype',
  'toString',
  'toLocaleString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
]);

// Reserved comes first so `__typename` says why it failed, not just that the pattern did.
export function checkApiName(name: string): SchemaErrorCode | null {
  if (name.startsWith('__') || RESERVED.has(name)) return 'schema.name_reserved';
  return API_NAME.test(name) ? null : 'schema.name_invalid';
}

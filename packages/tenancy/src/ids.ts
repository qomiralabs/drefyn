import { TenancyError } from './errors.ts';

// The kind is the public prefix itself. Adding one is additive; renaming one breaks the API.
export const ID_KINDS = Object.freeze([
  'org',
  'prj',
  'usr',
  'mem',
  'key',
  'nod',
  'ver',
  'ast',
  'cmp',
  'inc',
  'sub',
  'whk',
  'evt',
  'crd',
] as const);

export type IdKind = (typeof ID_KINDS)[number];

// Not exported, so no other module can name the brand and mint an id without validation.
declare const idBrand: unique symbol;

export type IdOf<K extends IdKind> = string & { readonly [idBrand]: K };
export type OrganizationId = IdOf<'org'>;
export type ProjectId = IdOf<'prj'>;

export interface OrganizationRef {
  readonly organizationId: OrganizationId;
}

export interface TenantRef extends OrganizationRef {
  readonly projectId: ProjectId;
}

const KINDS: ReadonlySet<string> = new Set(ID_KINDS);

// Lowercase only: two spellings of one tenant would give two cache keys for it.
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && CANONICAL_UUID.test(value);
}

export function assertKind(kind: unknown): asserts kind is IdKind {
  if (typeof kind !== 'string' || !KINDS.has(kind)) throw new TenancyError('ID_KIND_UNKNOWN');
}

export function isKind(value: string): value is IdKind {
  return KINDS.has(value);
}

export function assertUuid(value: unknown): asserts value is string {
  if (!isCanonicalUuid(value)) throw new TenancyError('ID_MALFORMED');
}

export function idOf<K extends IdKind>(kind: K, value: string): IdOf<K> {
  assertKind(kind);
  assertUuid(value);
  return value as IdOf<K>;
}

export function organizationId(value: string): OrganizationId {
  return idOf('org', value);
}

export function projectId(value: string): ProjectId {
  return idOf('prj', value);
}

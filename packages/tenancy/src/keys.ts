import { createHash, type Hash } from 'node:crypto';
import { TenancyError } from './errors.ts';
import { assertUuid, type TenantRef } from './ids.ts';

declare const cacheKeyBrand: unique symbol;

export type CacheKey = string & { readonly [cacheKeyBrand]: true };

export type CacheScope = 'page' | 'nav' | 'search' | 'retrieval' | 'render' | 'asset';

const SCOPES: ReadonlySet<string> = new Set<CacheScope>([
  'page',
  'nav',
  'search',
  'retrieval',
  'render',
  'asset',
]);

// Different labels keep a cache key hash and a surrogate key hash apart for the same input.
const CACHE_DOMAIN = 'drefyn cache key v1\u0000';
const SURROGATE_DOMAIN = 'drefyn surrogate key v1\u0000';

// The ids are validated again here because the brand is only a type: a forged id holding a
// colon could shift the boundary between organization and project in the prefix.
function tenantPrefix(tenant: unknown, scope: unknown): string {
  if (typeof tenant !== 'object' || tenant === null) {
    throw new TenancyError('TENANT_REF_INVALID');
  }
  const { organizationId, projectId } = tenant as Partial<Record<keyof TenantRef, unknown>>;
  assertUuid(organizationId);
  assertUuid(projectId);
  if (typeof scope !== 'string' || !SCOPES.has(scope)) {
    throw new TenancyError('CACHE_SCOPE_UNKNOWN');
  }
  return `v1:${organizationId}:${projectId}:${scope}`;
}

// A length prefix per part keeps the encoding injective where any join would collide. UTF-16
// code units, not UTF-8, because UTF-8 maps every lone surrogate to the same U+FFFD.
function updatePart(hash: Hash, part: unknown): void {
  if (typeof part !== 'string') throw new TenancyError('CACHE_PART_INVALID');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(part.length);
  hash.update(length);
  hash.update(Buffer.from(part, 'utf16le'));
}

export function cacheKey(
  tenant: TenantRef,
  scope: CacheScope,
  ...parts: readonly string[]
): CacheKey {
  const prefix = tenantPrefix(tenant, scope);
  const hash = createHash('sha256').update(CACHE_DOMAIN);
  for (const part of parts) updatePart(hash, part);
  return `${prefix}:${hash.digest('base64url')}` as CacheKey;
}

// The id is hashed rather than appended: a raw id can hold spaces, which split a Surrogate-Key
// header into extra keys, and paths or titles that should not reach CDN logs.
export function surrogateKey(tenant: TenantRef, scope: CacheScope, id?: string): string {
  const prefix = tenantPrefix(tenant, scope);
  if (id === undefined) return prefix;
  const hash = createHash('sha256').update(SURROGATE_DOMAIN);
  updatePart(hash, id);
  return `${prefix}:${hash.digest('base64url')}`;
}

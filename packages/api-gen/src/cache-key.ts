import { cacheKey, type CacheKey, type TenantRef } from '@drefyn/tenancy';

// Both tenant ids sit in the key's prefix, so one project's compiled schema can never be served
// to another, even where two projects share a schema version number.
export function schemaCacheKey(tenant: TenantRef, projectSchemaVersion: number): CacheKey {
  if (!Number.isSafeInteger(projectSchemaVersion) || projectSchemaVersion < 0) {
    throw new RangeError('schemaCacheKey: version must be a whole number at or above zero');
  }
  return cacheKey(tenant, 'schema', String(projectSchemaVersion));
}

import { notImplemented } from './not-implemented.ts';

export interface TenantSettings {
  readonly organizationId: string;
  // Empty for an organization scoped transaction, so the project always gets set too.
  readonly projectId: string;
}

// Validates a context at run time, because a cast or an untyped caller can get past the
// branded types. Throws DbError DB_TENANT_CONTEXT_MISSING.
export function tenantSettings(ctx: unknown, scope: 'organization' | 'project'): TenantSettings {
  return notImplemented(`tenantSettings(${typeof ctx}, ${scope})`);
}

// The statement timeout for one transaction. Throws DbError DB_CONFIG_INVALID.
export function transactionTimeout(timeoutMs: unknown, fallbackMs: number): number {
  return notImplemented(`transactionTimeout(${typeof timeoutMs}, ${String(fallbackMs)})`);
}

import { createHash } from 'node:crypto';
import type { TenantRef } from '@drefyn/tenancy';

// Advisory locks share one 64 bit space across the whole cluster. Hashing the tenant ids with
// the binding id and a prefix keeps two tenants, or another feature, from ever meaning the same
// lock on purpose; a chance collision only makes one worker wait for the next turn.
export function bindingLockKey(tenant: TenantRef, bindingId: string): bigint {
  const digest = createHash('sha256')
    .update(`git_sync\u0000${tenant.organizationId}\u0000${tenant.projectId}\u0000${bindingId}`)
    .digest();
  return digest.readBigInt64BE(0);
}

import type { OrganizationId, TenantRef } from '@drefyn/tenancy';
import { tenantFields, type GitSyncLogger } from './types.ts';

export const GIT_SYNC_FLAG = 'docs.git_sync';
export const GIT_SYNC_FEATURE = 'docs.git_editing';

export type GateRefusal = 'git_sync.disabled' | 'git_sync.not_entitled';

export interface GitSyncGate {
  // null when the tenant may use git sync.
  check(tenant: TenantRef): Promise<GateRefusal | null>;
}

// The parts of a flag client and an entitlements reader the gate reads. Shaped so the real
// ones from @drefyn/flags fit without this package depending on them.
export interface GateSources {
  readonly flags: {
    isOn(
      name: typeof GIT_SYNC_FLAG,
      ctx: { readonly organizationId: OrganizationId; readonly projectId: string },
    ): Promise<boolean>;
  };
  readonly entitlements: {
    hasFeature(organizationId: OrganizationId, feature: typeof GIT_SYNC_FEATURE): Promise<boolean>;
  };
  readonly logger: GitSyncLogger;
}

// Fails closed: a flag or plan that cannot be read refuses, and says which one in the log.
export function createGitSyncGate(sources: GateSources): GitSyncGate {
  const read = async (
    tenant: TenantRef,
    source: 'flag' | 'entitlement',
    work: () => Promise<boolean>,
  ): Promise<boolean> => {
    try {
      return await work();
    } catch {
      sources.logger.warn('git_sync.gate_read_failed', { ...tenantFields(tenant), source });
      return false;
    }
  };
  return {
    async check(tenant) {
      const on = await read(tenant, 'flag', () =>
        sources.flags.isOn(GIT_SYNC_FLAG, {
          organizationId: tenant.organizationId,
          projectId: tenant.projectId,
        }),
      );
      if (!on) return 'git_sync.disabled';
      const entitled = await read(tenant, 'entitlement', () =>
        sources.entitlements.hasFeature(tenant.organizationId, GIT_SYNC_FEATURE),
      );
      return entitled ? null : 'git_sync.not_entitled';
    },
  };
}

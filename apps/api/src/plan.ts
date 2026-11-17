import { withOrganization, type Database } from '@drefyn/db';
import { hasFeature, type FeatureKey, type Tier } from '@drefyn/entitlements';
import type { ProvedTenant } from './guard.ts';

// Reads the organization's plan under its own RLS context and asks entitlements, so the tier
// rule lives in one place. A missing row or an unknown tier throws: the guard fails closed.
export function planFeature(
  db: Database,
  feature: FeatureKey,
): (tenant: ProvedTenant) => Promise<boolean> {
  return async ({ organizationId }) => {
    const row = await withOrganization(db, { organizationId }, (tx) =>
      tx
        .selectFrom('organizations')
        .select('plan_tier')
        .where('organization_id', '=', organizationId)
        .executeTakeFirst(),
    );
    if (row === undefined) throw new Error('organization has no row');
    return hasFeature(row.plan_tier as Tier, feature);
  };
}

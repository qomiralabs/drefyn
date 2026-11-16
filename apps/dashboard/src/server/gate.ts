import { connection } from 'next/server';
import { notFound } from 'next/navigation';
import type { FlagContext } from '@drefyn/flags';
import type { OrganizationId, UserId } from '@drefyn/tenancy';
import { dashboardEnabled, VISITOR_FLAG_ORGANIZATION } from '../shell/release.ts';
import { flagClient } from './flags.ts';
import { logWarn, type LogContext } from './log.ts';

export { mailDeliveryEnabled } from './flags.ts';

async function check(
  context: Pick<FlagContext, 'organizationId' | 'userId'>,
  logged: LogContext,
): Promise<void> {
  await connection();
  let enabled = false;
  try {
    enabled = await dashboardEnabled(await flagClient(), context);
  } catch {
    logWarn('dashboard.flag_client_failed', logged);
  }
  if (!enabled) notFound();
}

// Off, or any failure, is a 404 that says nothing about the dashboard. The flag is read per
// request, never at build time.
export function requireDashboard(organizationId: OrganizationId, userId: UserId): Promise<void> {
  return check({ organizationId, userId }, { organizationId });
}

// For a request with no person behind it. Flag off wins over the sign in redirect, so a
// dashboard the flag says does not exist never announces itself. No organization in the log
// context: the reserved id is not a tenant.
export function requireDashboardForVisitor(): Promise<void> {
  return check({ organizationId: VISITOR_FLAG_ORGANIZATION }, {});
}

import { connection } from 'next/server';
import { notFound } from 'next/navigation';
import { createFlagClient, loadFlagConfig, type FlagClient, type FlagContext } from '@drefyn/flags';
import type { OrganizationId, UserId } from '@drefyn/tenancy';
import { dashboardEnabled, mailDelivery, VISITOR_FLAG_ORGANIZATION } from '../shell/release.ts';
import { logWarn, type LogContext } from './log.ts';

let client: Promise<FlagClient> | undefined;

// One client per server process. A client that failed to start is dropped, so the next
// request tries again instead of keeping the dashboard off until a restart.
function flagClient(): Promise<FlagClient> {
  client ??= createFlagClient(loadFlagConfig(process.env), {
    // The dashboard reads release flags only; plan flags go through entitlements.
    entitlements: { hasFeature: () => Promise.resolve(false) },
    logger: {
      warn: (event, fields) => {
        logWarn(event, fields);
      },
    },
  }).catch((error: unknown) => {
    client = undefined;
    throw error;
  });
  return client;
}

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

// Asked once per process, about nobody in particular: mail is a server setting. Any failure
// is off, the safe value, and a change applies on restart.
export async function mailDeliveryEnabled(): Promise<boolean> {
  try {
    return await mailDelivery(await flagClient(), { organizationId: VISITOR_FLAG_ORGANIZATION });
  } catch {
    logWarn('dashboard.flag_client_failed', {});
    return false;
  }
}

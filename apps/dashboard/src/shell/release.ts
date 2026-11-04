import type { FlagClient, FlagContext } from '@drefyn/flags';
import { idOf, type OrganizationId } from '@drefyn/tenancy';

export const DASHBOARD_FLAG = 'dashboard.shell';
export const MAIL_FLAG = 'email.smtp_delivery';

// Who the flag is asked about when nobody is signed in. The nil UUID, which generated ids
// never are, so it belongs to no tenant and the answer can never depend on a slug.
export const VISITOR_FLAG_ORGANIZATION: OrganizationId = idOf(
  'org',
  '00000000-0000-0000-0000-000000000000',
);

// Anything but a clear yes keeps the dashboard off: a provider error, a timeout or an odd
// value all read as off, so an outage never exposes an unreleased surface.
export async function dashboardEnabled(
  client: FlagClient,
  context: Pick<FlagContext, 'organizationId' | 'userId'>,
): Promise<boolean> {
  try {
    // Typed as boolean, but only a real true turns the dashboard on.
    const value: unknown = await client.isOn(DASHBOARD_FLAG, context);
    return value === true;
  } catch {
    return false;
  }
}

export async function mailDelivery(
  client: FlagClient,
  context: Pick<FlagContext, 'organizationId'>,
): Promise<boolean> {
  try {
    const value: unknown = await client.isOn(MAIL_FLAG, context);
    return value === true;
  } catch {
    return false;
  }
}

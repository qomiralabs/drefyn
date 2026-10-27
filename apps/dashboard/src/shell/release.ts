import type { FlagClient, FlagContext } from '@drefyn/flags';

export const DASHBOARD_FLAG = 'dashboard.shell';

// Anything but a clear yes keeps the dashboard off: a provider error, a timeout or an odd
// value all read as off, so an outage never exposes an unreleased surface.
export async function dashboardEnabled(
  client: FlagClient,
  organizationId: string,
): Promise<boolean> {
  try {
    // Placeholder organizations carry readable ids until the tenancy API serves real ones.
    const ctx = { organizationId } as FlagContext;
    // Typed as boolean, but only a real true turns the dashboard on.
    const value: unknown = await client.isOn(DASHBOARD_FLAG, ctx);
    return value === true;
  } catch {
    return false;
  }
}

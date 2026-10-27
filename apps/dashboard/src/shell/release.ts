import type { FlagClient } from '@drefyn/flags';

export const DASHBOARD_FLAG = 'dashboard.shell';

// TODO(#59): read the release flag; anything but a clear yes keeps the dashboard off.
export const dashboardEnabled: (
  client: FlagClient,
  organizationId: string,
) => Promise<boolean> = () => Promise.resolve(true);

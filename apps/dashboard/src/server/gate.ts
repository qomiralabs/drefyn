import { connection } from 'next/server';
import { notFound } from 'next/navigation';
import { createFlagClient, loadFlagConfig, type FlagClient } from '@drefyn/flags';
import { dashboardEnabled } from '../shell/release.ts';
import { logWarn } from './log.ts';

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

// Every dashboard route calls this first. Off, or any failure, is a 404 that says nothing
// about the dashboard. The flag is read per request, never at build time.
export async function requireDashboard(organizationId: string): Promise<void> {
  await connection();
  let enabled = false;
  try {
    enabled = await dashboardEnabled(await flagClient(), organizationId);
  } catch {
    logWarn('dashboard.flag_client_failed', { organizationId });
  }
  if (!enabled) notFound();
}

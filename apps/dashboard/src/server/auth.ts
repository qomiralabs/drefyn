import { parseAuthConfig, type Env } from '@drefyn/auth';
import { parseAuthDatabaseConfig, parseDatabaseConfig } from '@drefyn/db';
import { parseEmailConfig } from '@drefyn/email/config';
import { checkEngineConfig } from '@drefyn/engine';
import type { DashboardAuth } from './auth-compose.ts';
import { dashboardData } from './engine-holder.ts';

export type { DashboardAuth } from './auth-compose.ts';
export { authConfig, sessionCookieName } from './auth-config.ts';

// Built on first use, once per process, with the engine: next build needs no database, and a
// failed start is dropped, so the next request tries again instead of keeping sign in down.
export async function dashboardAuth(): Promise<DashboardAuth> {
  return (await dashboardData()).auth;
}

// At boot, connecting to nothing: a bad key stops the start and names the key.
export function checkDashboardConfig(env: Env): void {
  parseAuthConfig(env);
  const { poolMax } = parseDatabaseConfig(env);
  parseAuthDatabaseConfig(env);
  checkEngineConfig(env, poolMax);
  const email = parseEmailConfig(env);
  if (!email.ok) throw new Error(`${email.error.key} ${email.error.reason}`);
}

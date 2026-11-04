import {
  createOrganizations,
  createSessions,
  parseAuthConfig,
  type AuthConfig,
  type AuthLogger,
  type Env,
  type Organizations,
  type Sessions,
} from '@drefyn/auth';
import {
  createAuthDatabase,
  createDatabase,
  parseAuthDatabaseConfig,
  parseDatabaseConfig,
} from '@drefyn/db';
import { logInfo, logWarn, type LogContext } from './log.ts';

// Only what the dashboard calls. Each page issue adds what it needs, so nothing here is
// wiring that no test reaches, and createOrganizationFor, which takes a bare user id, stays
// out of reach.
export interface DashboardAuth {
  readonly sessions: Pick<Sessions, 'resolveAccess' | 'resolveSession' | 'touchSession'>;
  readonly organizations: Pick<Organizations, 'listMyOrganizations'>;
}

// Auth passes ids and outcome codes; a value of any other shape stays out of the log.
function plainFields(fields: Readonly<Record<string, unknown>>): LogContext {
  const kept: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (['string', 'number', 'boolean'].includes(typeof value)) {
      kept[key] = value as string | number | boolean;
    }
  }
  return kept;
}

const logger: AuthLogger = {
  info: (event, fields) => {
    logInfo(event, plainFields(fields));
  },
  warn: (event, fields) => {
    logWarn(event, plainFields(fields));
  },
};

let config: AuthConfig | undefined;

export function authConfig(): AuthConfig {
  config ??= parseAuthConfig(process.env);
  return config;
}

export function sessionCookieName(): string {
  return authConfig().cookies.session;
}

async function compose(): Promise<DashboardAuth> {
  const parsed = authConfig();
  const db = await createDatabase(parseDatabaseConfig(process.env));
  const authDb = await createAuthDatabase(parseAuthDatabaseConfig(process.env));
  const sessions = createSessions(parsed, { db, authDb, logger });
  // The tier of an organization this root never creates; hosted refuses it in the database.
  const organizations = createOrganizations(parsed, {
    db,
    authDb,
    logger,
    initialTier: 'self_hosted',
  });
  return {
    sessions: {
      resolveAccess: (cookie, slug) => sessions.resolveAccess(cookie, slug),
      resolveSession: (cookie) => sessions.resolveSession(cookie),
      touchSession: (ref) => sessions.touchSession(ref),
    },
    organizations: {
      listMyOrganizations: (session) => organizations.listMyOrganizations(session),
    },
  };
}

let built: Promise<DashboardAuth> | undefined;

// Built on first use, so next build needs no database. A failed start is dropped, so the
// next request tries again instead of keeping sign in down until a restart.
export function dashboardAuth(): Promise<DashboardAuth> {
  built ??= compose().catch((error: unknown) => {
    built = undefined;
    throw error;
  });
  return built;
}

// At boot, connecting to nothing: a bad key stops the start and names the key.
export function checkDashboardConfig(env: Env): void {
  parseAuthConfig(env);
  parseDatabaseConfig(env);
  parseAuthDatabaseConfig(env);
}

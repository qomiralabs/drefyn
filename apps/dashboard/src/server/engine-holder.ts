import {
  closeDatabase,
  createAuthDatabase,
  createDatabase,
  parseAuthDatabaseConfig,
  parseDatabaseConfig,
  type AuthDatabase,
  type Database,
} from '@drefyn/db';
import {
  createEngine,
  databaseStore,
  parseEngineConfig,
  type Engine,
  type EngineDeps,
  type EngineStore,
} from '@drefyn/engine';
import { logInfo, logWarn } from './log.ts';

export interface DashboardData {
  // The only drefyn_app handle in this process. Auth and the engine share it.
  readonly appDb: Database;
  // The only drefyn_auth handle in this process.
  readonly authDb: AuthDatabase;
  readonly store: EngineStore;
  readonly engine: Engine;
}

// A global under a registered symbol, because server.ts and each Next layer load separate
// copies of this module. The engine's gate counts per handle, so a handle per copy would give
// each layer its own count and the ceiling would multiply with no sign.
const HOLDER = Symbol.for('drefyn.engine');

interface Holder {
  data?: Promise<DashboardData> | undefined;
}

const global = globalThis as unknown as Record<symbol, Holder | undefined>;
const holder = (): Holder => (global[HOLDER] ??= {});

// No route here parses, and no parse worker runs in the dashboard yet. A write that reached
// the engine anyway is refused as the host being down, which is retryable and never a write.
const refusingParse: EngineDeps['parse'] = {
  print: () =>
    Promise.resolve({
      ok: false,
      error: [{ code: 'mdx.parse_unavailable', severity: 'error', line: 0, column: 0 }],
    }),
};

const PARSE_POLICY: EngineDeps['parsePolicy'] = {
  version: 1,
  components: [],
  rawHtml: 'sanitize',
  remoteImages: 'proxy',
  linkProtocols: ['https', 'http', 'mailto'],
};

// The dashboard only lists. Writes stay off here even where the flag is on for the API.
const NO_WRITES: EngineDeps['flags'] = {
  evaluate: () => Promise.resolve({ value: false }),
};

const opened = (role: 'drefyn_app' | 'drefyn_auth') => {
  logInfo('dashboard.database_opened', { role });
};

async function build(): Promise<DashboardData> {
  const env = process.env;
  const config = parseEngineConfig(env);
  const appDb = await createDatabase(parseDatabaseConfig(env));
  let authDb: AuthDatabase | undefined;
  try {
    opened('drefyn_app');
    authDb = await createAuthDatabase(parseAuthDatabaseConfig(env));
    opened('drefyn_auth');
    const store = databaseStore(appDb, config);
    const engine = createEngine({
      store,
      config,
      parse: refusingParse,
      parsePolicy: PARSE_POLICY,
      flags: NO_WRITES,
      logger: {
        info: (event, fields) => {
          logInfo(event, fields);
        },
        warn: (event, fields) => {
          logWarn(event, fields);
        },
      },
    });
    return { appDb, authDb, store, engine };
  } catch (error) {
    await closeDatabase(appDb);
    if (authDb !== undefined) await closeDatabase(authDb);
    throw error;
  }
}

// Built on first use, so next build needs no database. A failed build is dropped, so the next
// request tries again instead of keeping the dashboard down until a restart.
export function dashboardData(): Promise<DashboardData> {
  const held = holder();
  held.data ??= build().catch((error: unknown) => {
    held.data = undefined;
    throw error;
  });
  return held.data;
}

export function forgetDashboardData(): void {
  holder().data = undefined;
}

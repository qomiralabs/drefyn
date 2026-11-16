import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Shared across module copies: vi.resetModules gives the holder a fresh module, never fresh
// fakes, so a count here is a count for the process.
const fake = vi.hoisted(() => {
  const config = { poolCeiling: undefined, queryMaxInFlight: 4 };
  return {
    config,
    appDb: { role: 'app' },
    authDb: { role: 'auth' },
    gate: { name: 'the gate' },
    engine: { name: 'the engine' },
    createDatabase: vi.fn(),
    createAuthDatabase: vi.fn(),
    closeDatabase: vi.fn(() => Promise.resolve()),
    parseDatabaseConfig: vi.fn(() => ({ url: 'app' })),
    parseAuthDatabaseConfig: vi.fn(() => ({ url: 'auth' })),
    parseEngineConfig: vi.fn(() => config),
    databaseStore: vi.fn(),
    createEngine: vi.fn(),
    auth: { name: 'the auth' },
    composeAuth: vi.fn(),
  };
});

vi.mock('@drefyn/db', () => ({
  createDatabase: fake.createDatabase,
  createAuthDatabase: fake.createAuthDatabase,
  closeDatabase: fake.closeDatabase,
  parseDatabaseConfig: fake.parseDatabaseConfig,
  parseAuthDatabaseConfig: fake.parseAuthDatabaseConfig,
}));
vi.mock('../src/server/auth-compose.ts', () => ({ composeAuth: fake.composeAuth }));
vi.mock('@drefyn/engine', () => ({
  parseEngineConfig: fake.parseEngineConfig,
  databaseStore: fake.databaseStore,
  createEngine: fake.createEngine,
}));

const load = async () => {
  vi.resetModules();
  return import('../src/server/engine-holder.ts');
};

let info: { readonly mock: { readonly calls: unknown[][] } };

beforeEach(async () => {
  vi.clearAllMocks();
  fake.createDatabase.mockResolvedValue(fake.appDb);
  fake.createAuthDatabase.mockResolvedValue(fake.authDb);
  fake.databaseStore.mockImplementation(() => ({ gate: fake.gate, tenant: vi.fn() }));
  fake.createEngine.mockReturnValue(fake.engine);
  fake.composeAuth.mockResolvedValue(fake.auth);
  info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  (await load()).forgetDashboardData();
});

afterEach(async () => {
  (await load()).forgetDashboardData();
});

const opened = () =>
  info.mock.calls
    .map(([line]: unknown[]) => JSON.parse(String(line)) as Record<string, unknown>)
    .filter((line) => line['event'] === 'dashboard.database_opened');

describe('the engine holder', () => {
  it('opens nothing until asked', async () => {
    await load();
    expect(fake.createDatabase).not.toHaveBeenCalled();
    expect(fake.createAuthDatabase).not.toHaveBeenCalled();
  });

  it('gives two module copies the same handles, gate and engine, built once', async () => {
    const first = await (await load()).dashboardData();
    const second = await (await load()).dashboardData();
    expect(second.appDb).toBe(first.appDb);
    expect(second.authDb).toBe(first.authDb);
    expect(second.store.gate).toBe(first.store.gate);
    expect(second.engine).toBe(first.engine);
    expect(fake.createDatabase).toHaveBeenCalledTimes(1);
    expect(fake.createAuthDatabase).toHaveBeenCalledTimes(1);
    expect(fake.databaseStore).toHaveBeenCalledTimes(1);
    expect(fake.createEngine).toHaveBeenCalledTimes(1);
  });

  it('composes auth once per process, over the same two handles, in the same build', async () => {
    const first = await (await load()).dashboardData();
    const second = await (await load()).dashboardData();
    expect(second.auth).toBe(first.auth);
    expect(fake.composeAuth).toHaveBeenCalledTimes(1);
    expect(fake.composeAuth).toHaveBeenCalledWith(fake.appDb, fake.authDb);
  });

  it('drops the whole build when auth cannot be composed, closing both handles', async () => {
    fake.composeAuth.mockRejectedValueOnce(new Error('breached list'));
    const holder = await load();
    await expect(holder.dashboardData()).rejects.toThrow('breached list');
    expect(fake.closeDatabase).toHaveBeenCalledWith(fake.appDb);
    expect(fake.closeDatabase).toHaveBeenCalledWith(fake.authDb);
    await expect(holder.dashboardData()).resolves.toMatchObject({ auth: fake.auth });
  });

  it('builds once when the first callers arrive together', async () => {
    const holder = await load();
    const [a, b] = await Promise.all([holder.dashboardData(), holder.dashboardData()]);
    expect(b).toBe(a);
    expect(fake.createDatabase).toHaveBeenCalledTimes(1);
  });

  it('builds the store over the app handle, never the auth handle', async () => {
    const data = await (await load()).dashboardData();
    expect(data.appDb).toBe(fake.appDb);
    expect(data.authDb).toBe(fake.authDb);
    expect(fake.databaseStore.mock.calls[0]?.[0]).toBe(fake.appDb);
  });

  it('hands the store and the engine the one parsed config object', async () => {
    await (await load()).dashboardData();
    expect(fake.parseEngineConfig).toHaveBeenCalledTimes(1);
    const storeConfig: unknown = fake.databaseStore.mock.calls[0]?.[1];
    const deps = fake.createEngine.mock.calls[0]?.[0] as { config: unknown; store: unknown };
    expect(storeConfig).toBe(fake.config);
    expect(deps.config).toBe(storeConfig);
    expect(deps.store).toBe(fake.databaseStore.mock.results[0]?.value);
  });

  it('gives the engine a parse that refuses as the parse host being down', async () => {
    await (await load()).dashboardData();
    const deps = fake.createEngine.mock.calls[0]?.[0] as {
      parse: { print: (request: unknown) => Promise<unknown> };
    };
    expect(await deps.parse.print({})).toEqual({
      ok: false,
      error: [{ code: 'mdx.parse_unavailable', severity: 'error', line: 0, column: 0 }],
    });
  });

  it('keeps engine writes off whatever the flag source says', async () => {
    await (await load()).dashboardData();
    const deps = fake.createEngine.mock.calls[0]?.[0] as {
      flags: { evaluate: (name: string, context: unknown) => Promise<{ value: boolean }> };
    };
    expect((await deps.flags.evaluate('engine.writes', {})).value).toBe(false);
  });

  it('sends engine log lines to the dashboard log as they come', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await (await load()).dashboardData();
    const { logger } = fake.createEngine.mock.calls[0]?.[0] as {
      logger: {
        info: (event: string, fields: Record<string, string>) => void;
        warn: (event: string, fields: Record<string, string>) => void;
      };
    };
    logger.info('engine.query', { organization_id: 'o' });
    logger.warn('engine.query_busy', { organization_id: 'o' });
    expect(JSON.parse(String(info.mock.calls.at(-1)?.[0]))).toEqual({
      level: 'info',
      event: 'engine.query',
      service: 'dashboard',
      organization_id: 'o',
    });
    expect(JSON.parse(String(warn.mock.calls.at(-1)?.[0]))).toMatchObject({
      event: 'engine.query_busy',
    });
  });

  it('logs one line per handle, with the role and nothing else of the connection', async () => {
    await (await load()).dashboardData();
    await (await load()).dashboardData();
    expect(opened()).toEqual([
      {
        level: 'info',
        event: 'dashboard.database_opened',
        service: 'dashboard',
        role: 'drefyn_app',
      },
      {
        level: 'info',
        event: 'dashboard.database_opened',
        service: 'dashboard',
        role: 'drefyn_auth',
      },
    ]);
  });

  it('drops a failed build and closes what it opened, so the next call tries again', async () => {
    fake.createAuthDatabase.mockRejectedValueOnce(new Error('down'));
    const holder = await load();
    await expect(holder.dashboardData()).rejects.toThrow('down');
    expect(fake.closeDatabase).toHaveBeenCalledWith(fake.appDb);
    await expect(holder.dashboardData()).resolves.toMatchObject({ authDb: fake.authDb });
    expect(fake.createDatabase).toHaveBeenCalledTimes(2);
  });

  it('drops a build whose store refuses the config', async () => {
    fake.databaseStore.mockImplementationOnce(() => {
      throw new Error('ceiling');
    });
    const holder = await load();
    await expect(holder.dashboardData()).rejects.toThrow('ceiling');
    expect(fake.closeDatabase).toHaveBeenCalledWith(fake.appDb);
    expect(fake.closeDatabase).toHaveBeenCalledWith(fake.authDb);
    await expect(holder.dashboardData()).resolves.toBeDefined();
  });
});

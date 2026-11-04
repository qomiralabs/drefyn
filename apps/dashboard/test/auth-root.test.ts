import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createDatabase = vi.fn();
const createAuthDatabase = vi.fn();
const createSessions = vi.fn();
const createOrganizations = vi.fn();
const parseAuthConfig = vi.fn();
const parseDatabaseConfig = vi.fn();
const parseAuthDatabaseConfig = vi.fn();

vi.mock('@drefyn/db', () => ({
  createDatabase,
  createAuthDatabase,
  parseDatabaseConfig,
  parseAuthDatabaseConfig,
  withOrganization: vi.fn(),
}));
vi.mock('@drefyn/email/config', () => ({ parseEmailConfig: () => ({ ok: true }) }));
vi.mock('@drefyn/auth', () => ({ createSessions, createOrganizations, parseAuthConfig }));

const CONFIG = {
  appOrigin: 'https://app.drefyn.test',
  email: 'auto',
  cookies: { session: '__Host-drefyn_session' },
};
const sessions = {
  resolveAccess: vi.fn(),
  resolveSession: vi.fn(),
  touchSession: vi.fn(),
  startSession: vi.fn(),
};
const organizations = {
  listMyOrganizations: vi.fn(),
  createOrganizationFor: vi.fn(),
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  parseAuthConfig.mockReturnValue(CONFIG);
  createDatabase.mockResolvedValue({});
  createAuthDatabase.mockResolvedValue({});
  createSessions.mockReturnValue(sessions);
  createOrganizations.mockReturnValue(organizations);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const dashboardMail = vi.fn(() => Promise.resolve({ auth: {}, configured: true }));
vi.mock('../src/server/auth-mailer.ts', () => ({ dashboardMail, noteEmailOff: vi.fn() }));
vi.mock('../src/server/gate.ts', () => ({ mailDeliveryEnabled: () => Promise.resolve(false) }));

const load = async () => import('../src/server/auth.ts');

describe('the composition root', () => {
  it('opens nothing until the first call, then builds once', async () => {
    const { dashboardAuth } = await load();
    expect(createDatabase).not.toHaveBeenCalled();
    await dashboardAuth();
    await dashboardAuth();
    expect(createDatabase).toHaveBeenCalledTimes(1);
    expect(createAuthDatabase).toHaveBeenCalledTimes(1);
  });

  it('exposes only what the dashboard calls', async () => {
    const { dashboardAuth } = await load();
    const auth = await dashboardAuth();
    expect(Object.keys(auth.sessions).sort()).toEqual([
      'resolveAccess',
      'resolveSession',
      'touchSession',
    ]);
    expect(Object.keys(auth.organizations)).toEqual(['listMyOrganizations']);
    expect(Object.keys(auth).sort()).toEqual(['emailOn', 'organizations', 'sessions']);
  });

  it('reports email on only with a working mailer', async () => {
    const { dashboardAuth } = await load();
    expect((await dashboardAuth()).emailOn).toBe(true);
    vi.resetModules();
    dashboardMail.mockResolvedValueOnce({ auth: {}, configured: false });
    expect((await (await load()).dashboardAuth()).emailOn).toBe(false);
  });

  it('keeps the method receivers working', async () => {
    const owner = {
      id: 7,
      listMyOrganizations(this: { id: number }) {
        return this.id;
      },
    };
    createOrganizations.mockReturnValue(owner);
    const { dashboardAuth } = await load();
    const auth = await dashboardAuth();
    expect(auth.organizations.listMyOrganizations({} as never)).toBe(7);
  });

  it('drops a failed start, so the next request tries again', async () => {
    createDatabase.mockRejectedValueOnce(new Error('down'));
    const { dashboardAuth } = await load();
    await expect(dashboardAuth()).rejects.toThrow('down');
    await expect(dashboardAuth()).resolves.toBeDefined();
    expect(createDatabase).toHaveBeenCalledTimes(2);
  });

  it('passes auth log lines through the dashboard log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { dashboardAuth } = await load();
    await dashboardAuth();
    const { logger } = createSessions.mock.calls[0]?.[1] as {
      logger: {
        warn: (e: string, f: Record<string, unknown>) => void;
        info: (e: string, f: Record<string, unknown>) => void;
      };
    };
    logger.warn('auth.x', { reason: 'y', nested: { no: 1 } });
    logger.info('auth.z', {});
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
      level: 'warn',
      event: 'auth.x',
      service: 'dashboard',
      reason: 'y',
    });
    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toMatchObject({ event: 'auth.z' });
  });

  it('names the session cookie from the config alone, with no database', async () => {
    const { sessionCookieName } = await load();
    expect(sessionCookieName()).toBe('__Host-drefyn_session');
    expect(sessionCookieName()).toBe('__Host-drefyn_session');
    expect(parseAuthConfig).toHaveBeenCalledTimes(1);
    expect(createDatabase).not.toHaveBeenCalled();
  });

  it('checks every key at boot without connecting', async () => {
    const { checkDashboardConfig } = await load();
    const env = { A: '1' };
    checkDashboardConfig(env);
    expect(parseAuthConfig).toHaveBeenCalledWith(env);
    expect(parseDatabaseConfig).toHaveBeenCalledWith(env);
    expect(parseAuthDatabaseConfig).toHaveBeenCalledWith(env);
    expect(createDatabase).not.toHaveBeenCalled();
  });

  it('lets a bad key stop the boot', async () => {
    parseAuthDatabaseConfig.mockImplementationOnce(() => {
      throw new Error('DREFYN_AUTH_DATABASE_URL');
    });
    const { checkDashboardConfig } = await load();
    expect(() => {
      checkDashboardConfig({});
    }).toThrow('DREFYN_AUTH_DATABASE_URL');
  });
});

import { idOf } from '@drefyn/tenancy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VISITOR_FLAG_ORGANIZATION } from '../src/shell/release.ts';

const NOT_FOUND = new Error('NEXT_NOT_FOUND');
const isOn = vi.fn<() => Promise<boolean>>();
const createFlagClient = vi.fn();

vi.mock('next/server', () => ({ connection: () => Promise.resolve() }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw NOT_FOUND;
  },
}));
vi.mock('@drefyn/flags', () => ({
  loadFlagConfig: () => ({ source: 'file', file: '/flags.json' }),
  createFlagClient: (...args: unknown[]) => createFlagClient(...args) as unknown,
}));

const ORG = idOf('org', '01890a5d-ac96-774b-bcce-b302099a8070');
const USER = idOf('usr', '01890a5d-ac96-774b-bcce-b302099a8071');
const warnings: string[] = [];

beforeEach(() => {
  vi.resetModules();
  isOn.mockReset();
  createFlagClient.mockReset();
  createFlagClient.mockResolvedValue({ isOn, evaluate: vi.fn(), close: vi.fn() });
  warnings.length = 0;
  vi.spyOn(console, 'warn').mockImplementation((line: string) => {
    warnings.push(line);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const gate = async () => (await import('../src/server/gate.ts')).requireDashboard;

const visitor = async () => (await import('../src/server/gate.ts')).requireDashboardForVisitor;

describe('requireDashboardForVisitor', () => {
  it('asks with the reserved id and no user', async () => {
    isOn.mockResolvedValue(true);
    await expect((await visitor())()).resolves.toBeUndefined();
    expect(isOn).toHaveBeenCalledWith('dashboard.shell', {
      organizationId: VISITOR_FLAG_ORGANIZATION,
    });
  });

  it('is a 404 when off', async () => {
    isOn.mockResolvedValue(false);
    await expect((await visitor())()).rejects.toBe(NOT_FOUND);
  });

  it('logs a failed client with no organization field', async () => {
    createFlagClient.mockRejectedValueOnce(new Error('bad config'));
    await expect((await visitor())()).rejects.toBe(NOT_FOUND);
    expect(JSON.parse(warnings[0] ?? '{}')).toEqual({
      level: 'warn',
      event: 'dashboard.flag_client_failed',
      service: 'dashboard',
    });
  });
});

describe('requireDashboard', () => {
  it('passes both real ids to the flag', async () => {
    isOn.mockResolvedValue(true);
    await (
      await gate()
    )(ORG, USER);
    expect(isOn).toHaveBeenCalledWith('dashboard.shell', { organizationId: ORG, userId: USER });
  });

  it('lets the request through when the flag is on', async () => {
    isOn.mockResolvedValue(true);
    await expect((await gate())(ORG, USER)).resolves.toBeUndefined();
  });

  it('is a 404 when the flag is off', async () => {
    isOn.mockResolvedValue(false);
    await expect((await gate())(ORG, USER)).rejects.toBe(NOT_FOUND);
  });

  it('is a 404 and logs the organization when the client cannot start, then tries again', async () => {
    createFlagClient.mockRejectedValueOnce(new Error('bad config'));
    const requireDashboard = await gate();
    await expect(requireDashboard(ORG, USER)).rejects.toBe(NOT_FOUND);
    expect(warnings.map((w) => JSON.parse(w) as Record<string, string>)).toEqual([
      expect.objectContaining({
        event: 'dashboard.flag_client_failed',
        organizationId: ORG,
        service: 'dashboard',
      }),
    ]);
    isOn.mockResolvedValue(true);
    await expect(requireDashboard(ORG, USER)).resolves.toBeUndefined();
    expect(createFlagClient).toHaveBeenCalledTimes(2);
  });

  it('builds one client per process and passes provider warnings to the log', async () => {
    isOn.mockResolvedValue(true);
    const requireDashboard = await gate();
    await requireDashboard(ORG, USER);
    await requireDashboard(ORG, USER);
    expect(createFlagClient).toHaveBeenCalledTimes(1);
    const deps = createFlagClient.mock.calls[0]?.[1] as {
      logger: { warn: (event: string, fields?: Record<string, string>) => void };
      entitlements: { hasFeature: () => Promise<boolean> };
    };
    deps.logger.warn('flags.provider_not_ready', { organizationId: 'org_acme' });
    expect(JSON.parse(warnings[0] ?? '{}')).toMatchObject({
      level: 'warn',
      event: 'flags.provider_not_ready',
      organizationId: 'org_acme',
    });
    await expect(deps.entitlements.hasFeature()).resolves.toBe(false);
  });
});

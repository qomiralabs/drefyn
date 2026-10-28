import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('requireDashboard', () => {
  it('lets the request through when the flag is on', async () => {
    isOn.mockResolvedValue(true);
    await expect((await gate())('org_acme')).resolves.toBeUndefined();
  });

  it('is a 404 when the flag is off', async () => {
    isOn.mockResolvedValue(false);
    await expect((await gate())('org_acme')).rejects.toBe(NOT_FOUND);
  });

  it('is a 404 and logs the organization when the client cannot start, then tries again', async () => {
    createFlagClient.mockRejectedValueOnce(new Error('bad config'));
    const requireDashboard = await gate();
    await expect(requireDashboard('org_acme')).rejects.toBe(NOT_FOUND);
    expect(warnings.map((w) => JSON.parse(w) as Record<string, string>)).toEqual([
      expect.objectContaining({
        event: 'dashboard.flag_client_failed',
        organizationId: 'org_acme',
        service: 'dashboard',
      }),
    ]);
    isOn.mockResolvedValue(true);
    await expect(requireDashboard('org_acme')).resolves.toBeUndefined();
    expect(createFlagClient).toHaveBeenCalledTimes(2);
  });

  it('builds one client per process and passes provider warnings to the log', async () => {
    isOn.mockResolvedValue(true);
    const requireDashboard = await gate();
    await requireDashboard('org_acme');
    await requireDashboard('org_acme');
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

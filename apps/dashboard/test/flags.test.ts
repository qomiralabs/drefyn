import { idOf } from '@drefyn/tenancy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VISITOR_FLAG_ORGANIZATION } from '../src/shell/release.ts';

const isOn = vi.fn<(name: string, ctx: unknown) => Promise<unknown>>();
const createFlagClient = vi.fn();

vi.mock('@drefyn/flags', () => ({
  loadFlagConfig: () => ({ source: 'file', file: '/flags.json' }),
  createFlagClient: (...args: unknown[]) => createFlagClient(...args) as unknown,
}));

const ORG = idOf('org', '01890a5d-ac96-774b-bcce-b302099a8090');
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

const flags = () => import('../src/server/flags.ts');

describe('teamSsoForServer', () => {
  it('asks about nobody in particular and is on only for a real true', async () => {
    const { teamSsoForServer } = await flags();
    isOn.mockResolvedValueOnce(true).mockResolvedValueOnce('true').mockResolvedValueOnce(false);
    expect(await teamSsoForServer()).toBe(true);
    expect(await teamSsoForServer()).toBe(false);
    expect(await teamSsoForServer()).toBe(false);
    expect(isOn).toHaveBeenCalledWith('auth.team_sso', {
      organizationId: VISITOR_FLAG_ORGANIZATION,
    });
  });

  it('is off when the flag throws', async () => {
    const { teamSsoForServer } = await flags();
    isOn.mockRejectedValue(new Error('flagd'));
    expect(await teamSsoForServer()).toBe(false);
  });

  it('is off and logged when the client cannot start, and the next ask tries again', async () => {
    const { teamSsoForServer } = await flags();
    createFlagClient.mockRejectedValueOnce(new Error('bad config'));
    expect(await teamSsoForServer()).toBe(false);
    expect(warnings.join('\n')).toContain('dashboard.flag_client_failed');
    isOn.mockResolvedValue(true);
    expect(await teamSsoForServer()).toBe(true);
    expect(createFlagClient).toHaveBeenCalledTimes(2);
  });
});

describe('teamSsoFlag', () => {
  it('asks the flag for the organization it is given', async () => {
    const { teamSsoFlag } = await flags();
    isOn.mockResolvedValue(true);
    expect(await teamSsoFlag.isOn('auth.team_sso', { organizationId: ORG })).toBe(true);
    expect(isOn).toHaveBeenCalledWith('auth.team_sso', { organizationId: ORG });
  });
});

describe('mailDeliveryEnabled', () => {
  it('asks about nobody in particular and is off on any failure', async () => {
    const { mailDeliveryEnabled } = await flags();
    isOn.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('flagd'));
    expect(await mailDeliveryEnabled()).toBe(true);
    expect(await mailDeliveryEnabled()).toBe(false);
    expect(isOn).toHaveBeenCalledWith('email.smtp_delivery', {
      organizationId: VISITOR_FLAG_ORGANIZATION,
    });
    createFlagClient.mockRejectedValueOnce(new Error('bad config'));
    vi.resetModules();
    const fresh = await flags();
    expect(await fresh.mailDeliveryEnabled()).toBe(false);
    expect(warnings.join('\n')).toContain('dashboard.flag_client_failed');
  });
});

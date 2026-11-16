import { afterEach, describe, expect, it, vi } from 'vitest';
import { RECHECK_EVERY_MS, startSsoDomainRecheckJob } from '../src/server/sso-domain-recheck.ts';

const teamSsoForServer = vi.fn<() => Promise<boolean>>();

vi.mock('../src/server/flags.ts', () => ({
  teamSsoForServer: () => teamSsoForServer(),
  teamSsoFlag: { isOn: () => Promise.resolve(true) },
  mailDeliveryEnabled: () => Promise.resolve(false),
}));

function lines() {
  const seen: Record<string, unknown>[] = [];
  const capture = (text: string) => seen.push(JSON.parse(text) as Record<string, unknown>);
  vi.spyOn(console, 'info').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  return seen;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startSsoDomainRecheckJob', () => {
  it('with the flag on, reports a run that cannot build, with no detail, and stops cleanly', async () => {
    vi.useFakeTimers();
    const seen = lines();
    teamSsoForServer.mockResolvedValue(true);
    const job = startSsoDomainRecheckJob({});
    await vi.advanceTimersByTimeAsync(RECHECK_EVERY_MS);
    job.stop();
    expect(seen).toContainEqual({
      level: 'warn',
      event: 'dashboard.sso_recheck_failed',
      service: 'dashboard',
    });
  });

  it('with the flag off, builds nothing and logs nothing', async () => {
    vi.useFakeTimers();
    const seen = lines();
    teamSsoForServer.mockResolvedValue(false);
    const job = startSsoDomainRecheckJob({});
    await vi.advanceTimersByTimeAsync(RECHECK_EVERY_MS * 3);
    job.stop();
    expect(teamSsoForServer).toHaveBeenCalled();
    expect(seen).toEqual([]);
  });
});

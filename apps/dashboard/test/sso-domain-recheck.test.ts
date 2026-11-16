import type { SsoDomainRecheck, SsoDomainRecheckSummary } from '@drefyn/auth';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RECHECK_EVERY_MS,
  openSsoDomainRecheck,
  reportRecheck,
  startSsoDomainRecheck,
} from '../src/server/sso-domain-recheck.ts';

const SUMMARY: SsoDomainRecheckSummary = {
  checked: 3,
  confirmed: 1,
  missed: 1,
  unknown: 1,
  unverified: 0,
  skipped: 2,
  failed: 0,
  more: false,
};

function lines() {
  const seen: Record<string, unknown>[] = [];
  const capture = (text: string) => seen.push(JSON.parse(text) as Record<string, unknown>);
  vi.spyOn(console, 'info').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  return seen;
}

// Timers fired by hand, so each tick is one step of the test.
function clock() {
  const timers: { work: () => void; ms: number; cancelled: boolean }[] = [];
  const setTimer = (work: () => void, ms: number) => {
    const timer = { work, ms, cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  const fire = async () => {
    const next = timers.at(-1);
    if (next === undefined || next.cancelled) throw new Error('no timer waiting');
    next.work();
    // Lets the flag answer, the run and the report settle before the next timer is read.
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };
  return { timers, setTimer, fire };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('startSsoDomainRecheck', () => {
  it('starts at a jittered point inside the first hour, then waits about an hour', async () => {
    lines();
    const { timers, setTimer, fire } = clock();
    const run = vi.fn(() => Promise.resolve(SUMMARY));
    startSsoDomainRecheck({
      enabled: () => Promise.resolve(true),
      run,
      random: () => 0.5,
      setTimer,
    });
    expect(timers[0]?.ms).toBe(RECHECK_EVERY_MS / 2);
    await fire();
    expect(run).toHaveBeenCalledTimes(1);
    const next = timers[1]?.ms ?? 0;
    expect(next).toBeGreaterThanOrEqual(RECHECK_EVERY_MS * 0.75);
    expect(next).toBeLessThanOrEqual(RECHECK_EVERY_MS * 1.25);
  });

  it('runs and logs the summary while the flag is on', async () => {
    const seen = lines();
    const { setTimer, fire } = clock();
    const run = vi.fn(() => Promise.resolve(SUMMARY));
    startSsoDomainRecheck({ enabled: () => Promise.resolve(true), run, setTimer });
    await fire();
    await fire();
    expect(run).toHaveBeenCalledTimes(2);
    expect(seen.filter((l) => l['event'] === 'dashboard.sso_recheck_done')).toHaveLength(2);
  });

  it('never runs while the flag is off, and keeps asking each tick', async () => {
    const seen = lines();
    const { timers, setTimer, fire } = clock();
    const run = vi.fn(() => Promise.resolve(SUMMARY));
    const enabled = vi.fn(() => Promise.resolve(false));
    startSsoDomainRecheck({ enabled, run, setTimer });
    await fire();
    await fire();
    expect(run).not.toHaveBeenCalled();
    expect(enabled).toHaveBeenCalledTimes(2);
    expect(timers).toHaveLength(3);
    expect(seen.filter((l) => l['event'] === 'dashboard.sso_recheck_done')).toEqual([]);
  });

  it('starts running on the tick after the flag turns on', async () => {
    lines();
    const { setTimer, fire } = clock();
    const run = vi.fn(() => Promise.resolve(SUMMARY));
    const enabled = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    startSsoDomainRecheck({ enabled, run, setTimer });
    await fire();
    expect(run).not.toHaveBeenCalled();
    await fire();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('reads a flag that throws as off', async () => {
    lines();
    const { setTimer, fire } = clock();
    const run = vi.fn(() => Promise.resolve(SUMMARY));
    startSsoDomainRecheck({ enabled: () => Promise.reject(new Error('flagd')), run, setTimer });
    await fire();
    expect(run).not.toHaveBeenCalled();
  });

  it('logs a failed run with no detail and tries again on the next tick', async () => {
    const seen = lines();
    const { timers, setTimer, fire } = clock();
    const run = vi
      .fn<() => Promise<SsoDomainRecheckSummary>>()
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.5:5432 login.acme.example'))
      .mockResolvedValue(SUMMARY);
    startSsoDomainRecheck({ enabled: () => Promise.resolve(true), run, setTimer });
    await fire();
    expect(seen).toContainEqual({
      level: 'warn',
      event: 'dashboard.sso_recheck_failed',
      service: 'dashboard',
    });
    expect(JSON.stringify(seen)).not.toMatch(/ECONNREFUSED|acme/);
    const retry = timers[1]?.ms ?? 0;
    expect(retry).toBeGreaterThanOrEqual(RECHECK_EVERY_MS * 0.75);
    await fire();
    expect(run).toHaveBeenCalledTimes(2);
    expect(seen.filter((l) => l['event'] === 'dashboard.sso_recheck_done')).toHaveLength(1);
  });

  it('waits for a slow run to end before the next tick is set, so runs never overlap', async () => {
    lines();
    const { timers, setTimer, fire } = clock();
    let finish: (summary: SsoDomainRecheckSummary) => void = () => undefined;
    const run = vi.fn(
      () =>
        new Promise<SsoDomainRecheckSummary>((done) => {
          finish = done;
        }),
    );
    startSsoDomainRecheck({ enabled: () => Promise.resolve(true), run, setTimer });
    await fire();
    expect(timers).toHaveLength(1);
    finish(SUMMARY);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(timers).toHaveLength(2);
  });

  it('stops: the waiting timer is cancelled and no new one is set', () => {
    lines();
    const { timers, setTimer } = clock();
    const schedule = startSsoDomainRecheck({
      enabled: () => Promise.resolve(true),
      run: () => Promise.resolve(SUMMARY),
      setTimer,
    });
    schedule.stop();
    expect(timers[0]?.cancelled).toBe(true);
  });

  it('runs on real timers that never hold the process open', async () => {
    vi.useFakeTimers();
    lines();
    const run = vi.fn(() => Promise.resolve(SUMMARY));
    const schedule = startSsoDomainRecheck({
      enabled: () => Promise.resolve(true),
      run,
      random: () => 0,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    schedule.stop();
    await vi.advanceTimersByTimeAsync(RECHECK_EVERY_MS * 2);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('reportRecheck', () => {
  it('logs counts only, and whether domains were left for the next run', () => {
    const seen = lines();
    reportRecheck({ ...SUMMARY, more: true });
    expect(seen).toEqual([
      {
        level: 'info',
        event: 'dashboard.sso_recheck_done',
        service: 'dashboard',
        checked: 3,
        confirmed: 1,
        missed: 1,
        unknown: 1,
        unverified: 0,
        skipped: 2,
        failed: 0,
        more: true,
      },
    ]);
  });
});

describe('openSsoDomainRecheck', () => {
  const recheck = (summary = SUMMARY): SsoDomainRecheck => ({
    runOnce: () => Promise.resolve(summary),
  });

  it('builds once, on the first run, and asks again after a failed build', async () => {
    const build = vi
      .fn<() => Promise<SsoDomainRecheck>>()
      .mockRejectedValueOnce(new Error('database down'))
      .mockResolvedValue(recheck());
    const run = openSsoDomainRecheck(build);
    expect(build).not.toHaveBeenCalled();
    await expect(run()).rejects.toThrow('database down');
    await expect(run()).resolves.toEqual(SUMMARY);
    await run();
    expect(build).toHaveBeenCalledTimes(2);
  });
});

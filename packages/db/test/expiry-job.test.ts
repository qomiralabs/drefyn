import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { DbError } from '../src/errors.ts';
import {
  retryDelayMs,
  startExpirySchedule,
  type ExpiryJobResult,
  type ExpiryRun,
} from '../src/expiry-job.ts';

const MINUTE = 60_000;
const TICK = 15 * MINUTE;

const COUNTS = { api_keys: 2 };
const ORGANIZATIONS = [{ table: 'api_keys', organizationId: 'org-1', deleted: 2 }];
const DONE: ExpiryJobResult = {
  ran: true,
  counts: COUNTS,
  organizations: ORGANIZATIONS,
  backlog: false,
};

// A timer the test fires by hand, so each delay the schedule asks for can be read.
function manualTimers() {
  const pending: { work: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    pending,
    setTimer: (work: () => void, ms: number) => {
      const entry = { work, ms, cancelled: false };
      pending.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    // Fires the newest timer and lets the attempt it started settle.
    fire: async () => {
      const entry = pending.at(-1);
      if (entry === undefined || entry.cancelled) throw new Error('no timer to fire');
      entry.work();
      await vi.waitFor(() => {
        expect(pending.at(-1)).not.toBe(entry);
      });
    },
  };
}

function schedule(run: () => Promise<ExpiryJobResult>, random = () => 0.5) {
  const timers = manualTimers();
  const reports: ExpiryRun[] = [];
  const handle = startExpirySchedule({
    run,
    onRun: (report) => reports.push(report),
    random,
    setTimer: timers.setTimer,
  });
  return { timers, reports, handle };
}

describe('the expiry schedule', () => {
  it('first runs within a minute of start, so a server that restarts often still gets a turn', () => {
    for (const value of [0, 0.5, 0.999]) {
      const { timers, handle } = schedule(
        () => Promise.resolve(DONE),
        () => value,
      );
      expect(timers.pending[0]?.ms).toBeGreaterThanOrEqual(0);
      expect(timers.pending[0]?.ms).toBeLessThan(MINUTE);
      handle.stop();
    }
  });

  it('reports a run and asks again after about a tick', async () => {
    const run = vi.fn(() => Promise.resolve(DONE));
    const { timers, reports } = schedule(run);
    await timers.fire();
    expect(run).toHaveBeenCalledTimes(1);
    expect(reports).toEqual([{ outcome: 'done', counts: COUNTS, organizations: ORGANIZATIONS }]);
    const next = timers.pending.at(-1)?.ms ?? 0;
    expect(next).toBeGreaterThanOrEqual(0.75 * TICK);
    expect(next).toBeLessThanOrEqual(1.25 * TICK);
  });

  it('reports nothing when another server holds the turn, and keeps ticking', async () => {
    const { timers, reports } = schedule(() => Promise.resolve({ ran: false }));
    await timers.fire();
    expect(reports).toEqual([]);
    expect(timers.pending.at(-1)?.ms).toBeGreaterThanOrEqual(0.75 * TICK);
  });

  it('comes back within about a minute while a backlog remains', async () => {
    const { timers } = schedule(() => Promise.resolve({ ...DONE, backlog: true }));
    await timers.fire();
    expect(timers.pending.at(-1)?.ms).toBeLessThanOrEqual(1.25 * MINUTE);
  });

  it('retries a failed run with growing delays, reports each failure, then recovers', async () => {
    const run = vi
      .fn<() => Promise<ExpiryJobResult>>()
      .mockRejectedValueOnce(new DbError('DB_UNAVAILABLE', 'gone'))
      .mockRejectedValueOnce(new Error('values from the statement'))
      .mockResolvedValue(DONE);
    const { timers, reports } = schedule(run, () => 1);
    await timers.fire();
    expect(timers.pending.at(-1)?.ms).toBe(MINUTE);
    await timers.fire();
    expect(timers.pending.at(-1)?.ms).toBe(2 * MINUTE);
    await timers.fire();
    expect(reports.map((r) => r.outcome)).toEqual(['failed', 'failed', 'done']);
    expect(reports.slice(0, 2)).toEqual([
      { outcome: 'failed', code: 'DB_UNAVAILABLE', attempt: 1 },
      { outcome: 'failed', code: 'unknown', attempt: 2 },
    ]);
    // A success clears the count, so the next failure starts small again.
    run.mockRejectedValueOnce(new Error('later'));
    await timers.fire();
    expect(reports.at(-1)).toEqual({ outcome: 'failed', code: 'unknown', attempt: 1 });
    expect(JSON.stringify(reports)).not.toContain('values from the statement');
  });

  it('never runs two attempts at once', async () => {
    let release: (result: ExpiryJobResult) => void = () => undefined;
    const run = vi.fn(
      () =>
        new Promise<ExpiryJobResult>((resolve) => {
          release = resolve;
        }),
    );
    const { timers } = schedule(run);
    timers.pending[0]?.work();
    expect(timers.pending).toHaveLength(1);
    release(DONE);
    await vi.waitFor(() => {
      expect(timers.pending).toHaveLength(2);
    });
  });

  it('survives a reporter that throws', async () => {
    const timers = manualTimers();
    startExpirySchedule({
      run: () => Promise.resolve(DONE),
      onRun: () => {
        throw new Error('sink gone');
      },
      random: () => 0.5,
      setTimer: timers.setTimer,
    });
    await timers.fire();
    expect(timers.pending).toHaveLength(2);
  });

  it('stops: the waiting timer is cancelled and a run in flight schedules nothing', async () => {
    const idle = schedule(() => Promise.resolve(DONE));
    idle.handle.stop();
    expect(idle.timers.pending[0]?.cancelled).toBe(true);

    let release: (result: ExpiryJobResult) => void = () => undefined;
    const busy = schedule(
      () =>
        new Promise<ExpiryJobResult>((resolve) => {
          release = resolve;
        }),
    );
    busy.timers.pending[0]?.work();
    busy.handle.stop();
    release(DONE);
    await new Promise((resolve) => setImmediate(resolve));
    expect(busy.timers.pending).toHaveLength(1);
  });

  it('uses real timers that never hold the process open by default', () => {
    const handle = startExpirySchedule({
      run: () => Promise.resolve(DONE),
      onRun: () => undefined,
    });
    handle.stop();
  });
});

describe('retryDelayMs', () => {
  it('stays jittered, positive and never past a tick, for any attempt', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (n, r) => {
          const ms = retryDelayMs(n, r);
          expect(ms).toBeGreaterThanOrEqual(MINUTE / 2);
          expect(ms).toBeLessThanOrEqual(TICK);
          expect(Number.isInteger(ms)).toBe(true);
        },
      ),
    );
  });
});

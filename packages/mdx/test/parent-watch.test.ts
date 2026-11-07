import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PARENT_CHECK_MS,
  PARENT_GONE_GRACE_MS,
  stopThenKill,
  watchParent,
} from '../src/parent-watch.ts';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('watchParent', () => {
  it('does nothing while the parent stays', () => {
    const gone = vi.fn();
    const stop = watchParent(gone, { parent: 7, ppid: () => 7 });
    vi.advanceTimersByTime(PARENT_CHECK_MS * 10_000);
    expect(gone).not.toHaveBeenCalled();
    stop();
  });

  it.each([0, 1])('reads an unchanging parent pid of %i as a live parent', (pid) => {
    // 0 is what PID 1 in a container sees, 1 what a child of init sees.
    const gone = vi.fn();
    const stop = watchParent(gone, { parent: pid, ppid: () => pid });
    vi.advanceTimersByTime(PARENT_CHECK_MS * 10_000);
    expect(gone).not.toHaveBeenCalled();
    stop();
  });

  it('fires within one check of the parent going, to init or to a subreaper', () => {
    for (const adopted of [1, 900]) {
      const gone = vi.fn();
      let ppid = 7;
      const stop = watchParent(gone, { parent: 7, ppid: () => ppid });
      vi.advanceTimersByTime(PARENT_CHECK_MS);
      ppid = adopted;
      expect(gone).not.toHaveBeenCalled();
      vi.advanceTimersByTime(PARENT_CHECK_MS);
      expect(gone).toHaveBeenCalledOnce();
      stop();
    }
  });

  it('fires once, even if it is adopted again', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 40 }), (pids) => {
        const gone = vi.fn();
        const parent = 3;
        let at = 0;
        const stop = watchParent(gone, { parent, ppid: () => pids[at] ?? parent });
        const first = pids.findIndex((pid) => pid !== parent);
        for (at = 0; at < pids.length; at += 1) {
          vi.advanceTimersByTime(PARENT_CHECK_MS);
          expect(gone).toHaveBeenCalledTimes(first !== -1 && at >= first ? 1 : 0);
        }
        stop();
      }),
      { seed: 426, numRuns: 200 },
    );
  });

  it('stops checking when told to', () => {
    const gone = vi.fn();
    let ppid = 7;
    const stop = watchParent(gone, { parent: 7, ppid: () => ppid });
    stop();
    ppid = 1;
    vi.advanceTimersByTime(PARENT_CHECK_MS * 10);
    expect(gone).not.toHaveBeenCalled();
  });

  it('never holds a process open', () => {
    const interval = vi.spyOn(globalThis, 'setInterval');
    const stop = watchParent(() => undefined, { parent: 7, ppid: () => 7 });
    const timer = interval.mock.results[0]?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    stop();
  });

  it('reads the real parent by default', () => {
    const gone = vi.fn();
    const stop = watchParent(gone);
    vi.advanceTimersByTime(PARENT_CHECK_MS * 3);
    expect(gone).not.toHaveBeenCalled();
    stop();
  });
});

describe('stopThenKill', () => {
  it('asks first, and leaves a process that stops in time alone', () => {
    const stop = vi.fn();
    const kill = vi.fn();
    stopThenKill(stop, kill);
    expect(stop).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(PARENT_GONE_GRACE_MS - 1);
    expect(kill).not.toHaveBeenCalled();
  });

  it('kills at the grace, since nothing else is left to', () => {
    const kill = vi.fn();
    stopThenKill(() => undefined, kill);
    vi.advanceTimersByTime(PARENT_GONE_GRACE_MS);
    expect(kill).toHaveBeenCalledOnce();
  });

  it('still kills when the stop throws', () => {
    const kill = vi.fn();
    expect(() => {
      stopThenKill(() => {
        throw new Error('no');
      }, kill);
    }).toThrow('no');
    vi.advanceTimersByTime(PARENT_GONE_GRACE_MS);
    expect(kill).toHaveBeenCalledOnce();
  });
});

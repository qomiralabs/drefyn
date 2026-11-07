import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { end, guard, limitFrom, ticksFor, watch } from '../src/watch.ts';

const PARENT = 4_242;

// Scripted answers, one a tick. The last repeats, so a run always ends the test or the tick cap.
function scripted(beats: readonly number[], parents: readonly number[] = []) {
  let tick = -1;
  const at = <T>(list: readonly T[], fallback: T) =>
    list[Math.min(Math.max(tick, 0), list.length - 1)] ?? fallback;
  return {
    beat: () => at(beats, 0),
    parent: () => at(parents, PARENT),
    wait: () => {
      tick += 1;
      if (tick > 10_000) throw new Error('the watch never ended');
    },
    ticks: () => tick,
  };
}

describe('watch', () => {
  it('calls a thread stalled after the limit of ticks with no beat', () => {
    const deps = scripted([1]);
    expect(watch(deps, { parent: PARENT, limitTicks: 3 })).toBe('stalled');
    expect(deps.ticks()).toBe(2);
  });

  it('calls a run gone on the first tick the parent differs, stalled or not', () => {
    const deps = scripted([1, 2, 3], [PARENT, PARENT, 1]);
    expect(watch(deps, { parent: PARENT, limitTicks: 100 })).toBe('orphaned');
    expect(deps.ticks()).toBe(2);
  });

  it('starts counting again after any beat', () => {
    const deps = scripted([1, 1, 2, 2, 3, 3, 3, 3]);
    expect(watch(deps, { parent: PARENT, limitTicks: 3 })).toBe('stalled');
    expect(deps.ticks()).toBe(7);
  });

  it('stalls on the first tick that closes a quiet run of the limit, and no sooner', () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 200 }),
        fc.integer({ min: 1, max: 20 }),
        (moves, limitTicks) => {
          let beat = 0;
          const beats = moves.map((moved) => (beat += moved ? 1 : 0));
          const deps = scripted(beats);
          expect(watch(deps, { parent: PARENT, limitTicks })).toBe('stalled');

          let tick = 0;
          let quiet = 0;
          let last = beats[0];
          for (; ; tick += 1) {
            const value = beats[Math.min(tick, beats.length - 1)];
            quiet = value === last ? quiet + 1 : 0;
            last = value;
            if (quiet >= limitTicks) break;
          }
          expect(deps.ticks()).toBe(tick);
        },
      ),
      { seed: 426, numRuns: 500 },
    );
  });
});

describe('end', () => {
  it.each([
    ['stalled', 'worker 9 blocked its event loop for 2000 ms'],
    ['orphaned', 'the run that started worker 9 is gone'],
  ] as const)('says why on %s, then kills', (reason, says) => {
    const lines: string[] = [];
    const kill = vi.fn();
    end(reason, { pid: 9, limitMs: 2_000, write: (line) => lines.push(line), kill });
    expect(lines.join('')).toContain(says);
    expect(kill).toHaveBeenCalledOnce();
  });

  it('still kills when the write fails, as it does once the run is gone', () => {
    const kill = vi.fn();
    const write = () => {
      throw new Error('EPIPE');
    };
    expect(() => {
      end('orphaned', { pid: 9, limitMs: 1, write, kill });
    }).toThrow('EPIPE');
    expect(kill).toHaveBeenCalledOnce();
  });
});

describe('guard', () => {
  const ending = () => {
    const lines: string[] = [];
    return { lines, pid: 9, write: (line: string) => lines.push(line), kill: vi.fn() };
  };
  const cell = () => new Int32Array(new SharedArrayBuffer(8));

  it('reads a cell nothing beats as a stall', () => {
    const seen = ending();
    guard({ cell: cell(), parent: process.ppid, limitMs: 4 }, seen);
    expect(seen.lines.join('')).toContain('blocked its event loop for 4 ms');
    expect(seen.kill).toHaveBeenCalledOnce();
  });

  it('reads a different parent as a run that is gone', () => {
    const seen = ending();
    guard({ cell: cell(), parent: process.ppid + 1, limitMs: 4 }, seen);
    expect(seen.lines.join('')).toContain('is gone');
    expect(seen.kill).toHaveBeenCalledOnce();
  });
});

describe('the limit', () => {
  it('reads a positive whole number of milliseconds', () => {
    expect(limitFrom('2000')).toBe(2_000);
  });

  it.each([undefined, '', '0', '-1', '1.5', 'soon', '1e9'])('falls back on %s', (value) => {
    expect(limitFrom(value)).toBe(limitFrom(undefined));
  });

  it('turns into at least four ticks of at most a second', () => {
    expect(ticksFor(2_000)).toEqual({ tickMs: 500, limitTicks: 4 });
    expect(ticksFor(600_000)).toEqual({ tickMs: 1_000, limitTicks: 600 });
  });
});

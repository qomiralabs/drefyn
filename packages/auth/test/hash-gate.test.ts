import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHashGate } from '../src/hash-gate.ts';

interface Held {
  readonly promise: Promise<string>;
  release(): void;
  fail(): void;
}

function held(label: string): Held {
  let release: () => void = () => undefined;
  let failIt: () => void = () => undefined;
  const promise = new Promise<string>((resolve, reject) => {
    release = () => {
      resolve(label);
    };
    failIt = () => {
      reject(new Error('hash failed'));
    };
  });
  return { promise, release, fail: failIt };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.useRealTimers();
});

describe('createHashGate', () => {
  it('runs at most the configured number of hashes at once', async () => {
    const gate = createHashGate({ concurrency: 2, queueMax: 64, waitMs: 2_000 });
    const work = [held('a'), held('b'), held('c')];
    const started: string[] = [];
    const results = work.map((w, i) =>
      gate.run(() => {
        started.push(String(i));
        return w.promise;
      }),
    );
    await tick();
    expect(started).toEqual(['0', '1']);
    expect(gate.active).toBe(2);
    expect(gate.waiting).toBe(1);
    work[0]?.release();
    await tick();
    expect(started).toEqual(['0', '1', '2']);
    work[1]?.release();
    work[2]?.release();
    await expect(Promise.all(results)).resolves.toEqual(['a', 'b', 'c']);
    expect(gate.active).toBe(0);
  });

  it('fails the 65th waiting hash at once with AUTH_UNAVAILABLE', async () => {
    const gate = createHashGate({ concurrency: 4, queueMax: 64, waitMs: 2_000 });
    const blocker = held('x');
    const running = Array.from({ length: 4 + 64 }, () => gate.run(() => blocker.promise));
    await tick();
    expect(gate.active).toBe(4);
    expect(gate.waiting).toBe(64);
    const started = performance.now();
    const extra = vi.fn(() => Promise.resolve('never'));
    const error: unknown = await gate.run(extra).catch((e: unknown) => e);
    expect(performance.now() - started).toBeLessThan(50);
    expect(error).toMatchObject({ code: 'AUTH_UNAVAILABLE', retryAfterSeconds: 1 });
    expect(extra).not.toHaveBeenCalled();
    blocker.release();
    await Promise.all(running);
  });

  it('with a queue of 0, refuses anything past the running hashes', async () => {
    const gate = createHashGate({ concurrency: 1, queueMax: 0, waitMs: 2_000 });
    const blocker = held('x');
    const first = gate.run(() => blocker.promise);
    await expect(gate.run(() => Promise.resolve('y'))).rejects.toMatchObject({
      code: 'AUTH_UNAVAILABLE',
    });
    blocker.release();
    await expect(first).resolves.toBe('x');
  });

  it('gives up on a slot after the wait and leaves the queue', async () => {
    vi.useFakeTimers();
    const gate = createHashGate({ concurrency: 1, queueMax: 64, waitMs: 2_000 });
    const blocker = held('x');
    const first = gate.run(() => blocker.promise);
    const work = vi.fn(() => Promise.resolve('late'));
    const waiting = gate.run(work).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(gate.waiting).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(waiting).resolves.toMatchObject({ code: 'AUTH_UNAVAILABLE' });
    expect(gate.waiting).toBe(0);
    blocker.release();
    await first;
    expect(work).not.toHaveBeenCalled();
    expect(gate.active).toBe(0);
  });

  it('frees the slot when a hash fails, and serves waiters in order', async () => {
    const gate = createHashGate({ concurrency: 1, queueMax: 64, waitMs: 2_000 });
    const failing = held('f');
    const order: string[] = [];
    const first = gate.run(() => failing.promise).catch(() => 'failed');
    const second = gate.run(() => {
      order.push('second');
      return Promise.resolve('2');
    });
    const third = gate.run(() => {
      order.push('third');
      return Promise.resolve('3');
    });
    failing.fail();
    await expect(Promise.all([first, second, third])).resolves.toEqual(['failed', '2', '3']);
    expect(order).toEqual(['second', 'third']);
    expect(gate.active).toBe(0);
  });

  it('frees the slot when the work throws before returning a promise', async () => {
    const gate = createHashGate({ concurrency: 1, queueMax: 64, waitMs: 2_000 });
    await expect(
      gate.run(() => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    await expect(gate.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });
});

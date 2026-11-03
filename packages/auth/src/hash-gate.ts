import { AuthError } from './errors.ts';

export interface HashGateOptions {
  // Hashes running at once. Each takes its memory cost and a libuv thread.
  readonly concurrency: number;
  // Waiting hashes past which a request is refused at once.
  readonly queueMax: number;
  // How long a waiter holds on for a slot before giving up.
  readonly waitMs: number;
}

export interface HashGate {
  run<T>(work: () => Promise<T>): Promise<T>;
  readonly active: number;
  readonly waiting: number;
}

interface Waiter {
  readonly start: () => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

// A refused request should come back soon, not hammer: one second is a few hash rounds.
const busy = () => new AuthError('AUTH_UNAVAILABLE', { retryAfterSeconds: 1 });

// Bounds the memory and threads password hashing can take in one process, whatever an
// attacker sends: a few run, a bounded queue waits a bounded time, the rest are refused.
export function createHashGate(options: HashGateOptions): HashGate {
  let active = 0;
  const queue: Waiter[] = [];

  function release(): void {
    const next = queue.shift();
    if (next === undefined) {
      active -= 1;
      return;
    }
    clearTimeout(next.timer);
    // The slot passes straight to the next waiter, so active does not change.
    next.start();
  }

  function slot(): Promise<void> {
    if (active < options.concurrency) {
      active += 1;
      return Promise.resolve();
    }
    if (queue.length >= options.queueMax) return Promise.reject(busy());
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        start: resolve,
        timer: setTimeout(() => {
          const at = queue.indexOf(waiter);
          if (at >= 0) queue.splice(at, 1);
          reject(busy());
        }, options.waitMs),
      };
      queue.push(waiter);
    });
  }

  return {
    async run<T>(work: () => Promise<T>): Promise<T> {
      await slot();
      try {
        return await work();
      } finally {
        release();
      }
    },
    get active() {
      return active;
    },
    get waiting() {
      return queue.length;
    },
  };
}

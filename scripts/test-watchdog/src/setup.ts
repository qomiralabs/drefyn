import { join } from 'node:path';
import { setInterval } from 'node:timers';
import { Worker } from 'node:worker_threads';
import { limitFrom, ticksFor } from './watch.ts';

// A sync loop never gives the thread back, so no timeout in that thread can fire and vitest
// waits on the worker for good. The watch needs a thread of its own. It ends the whole process
// on a SIGKILL, which is the only stop that a loop cannot ignore. Vitest then fails the file,
// and anything the worker started sees its parent go.
const started = Symbol.for('drefyn.test-watchdog');
const holder = process as unknown as Record<symbol, boolean>;

if (holder[started] !== true) {
  holder[started] = true;
  const limitMs = limitFrom(process.env['DREFYN_TEST_STALL_LIMIT_MS']);
  const { tickMs } = ticksFor(limitMs);
  const cell = new Int32Array(new SharedArrayBuffer(8));
  // From node:timers, so fake timers in a test cannot read as a stall.
  setInterval(() => Atomics.add(cell, 0, 1), tickMs).unref();
  // A path, not a URL: under a DOM test environment import.meta.url is not a file URL.
  new Worker(join(import.meta.dirname, 'thread.ts'), {
    workerData: { cell, parent: process.ppid, limitMs },
  }).unref();
}

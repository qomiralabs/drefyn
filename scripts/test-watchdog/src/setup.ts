import { setInterval } from 'node:timers';
import { URL } from 'node:url';
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
  // URL from node:url: a browser test environment replaces the global one with its own.
  new Worker(new URL('./thread.ts', import.meta.url), {
    workerData: { cell, parent: process.ppid, limitMs },
  }).unref();
}

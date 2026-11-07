import { writeSync } from 'node:fs';
import { watchRun } from './watch.ts';

// Runs in vitest's main process. A timeout around pnpm or turbo kills only that wrapper, and
// vitest, now a child of nobody, would carry on. A plain timer is enough here: this process
// runs no test code. Its workers notice it go, and their own watch ends them.
const started = Symbol.for('drefyn.test-watchdog.run');
const holder = process as unknown as Record<symbol, boolean>;

export default function setup(): void {
  if (holder[started] === true) return;
  holder[started] = true;
  watchRun({
    pid: process.pid,
    parent: process.ppid,
    ppid: () => process.ppid,
    write: (message) => writeSync(2, message),
    kill: () => process.kill(process.pid, 'SIGKILL'),
  });
}

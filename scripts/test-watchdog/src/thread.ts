import { writeSync } from 'node:fs';
import { workerData } from 'node:worker_threads';
import { guard } from './watch.ts';
import type { Guard } from './watch.ts';

guard(workerData as Guard, {
  pid: process.pid,
  // fd 2 directly: process.stderr in a thread goes through the main thread, which may be stuck.
  write: (message) => writeSync(2, message),
  kill: () => process.kill(process.pid, 'SIGKILL'),
});

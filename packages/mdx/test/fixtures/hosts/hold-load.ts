import { writeSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { basename } from 'node:path';

// Loaded with --import into a real host or supervisor. It holds the first module the entry loads
// past its parent watch until the parent is gone, so a test can kill the parent while the slow
// imports load, on cue rather than on a clock. It also reports the exit code, which nothing else
// sees once the parent is dead.
const self = process.execArgv.findIndex((flag) => flag.startsWith('--import='));
// The host refuses flags it does not know, and this one is the harness, not the host.
if (self !== -1) process.execArgv.splice(self, 1);

const RELEASE_LIMIT = 6_000;
const PASSED = new Set(['host-main.ts', 'supervisor-main.ts', 'parent-watch.ts']);
const slot = new Int32Array(new SharedArrayBuffer(4));
let held = false;

registerHooks({
  load(url, context, nextLoad) {
    const name = basename(new URL(url).pathname);
    if (!held && url.startsWith('file:') && !PASSED.has(name)) {
      held = true;
      const parent = process.ppid;
      writeSync(2, `hold-load: holding ${name}\n`);
      // Bounded, so a parent that is never killed fails the test rather than hanging it.
      for (let turn = 0; turn < RELEASE_LIMIT && process.ppid === parent; turn += 1) {
        Atomics.wait(slot, 0, 0, 10);
      }
      writeSync(2, 'hold-load: released\n');
    }
    return nextLoad(url, context);
  },
});

process.on('exit', (code) => {
  writeSync(2, `hold-load: exit ${String(code)}\n`);
});

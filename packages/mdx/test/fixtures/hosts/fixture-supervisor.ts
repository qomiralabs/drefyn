import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { watchParent } from '../../../src/parent-watch.ts';
import { createSupervisor } from '../../../src/supervisor.ts';

// The real supervisor over a host running a test script on its threads, so a stall in native
// code goes all the way from the pool to a restart.
const script = process.argv[2] ?? '';
const write = (level: string) => (event: string, fields: object) => {
  process.stdout.write(`${JSON.stringify({ level, event, ...fields })}\n`);
};
const supervisor = createSupervisor(
  { backoffMs: 50, maxBackoffMs: 100, crashLimit: 100, crashWindowMs: 60_000, coolOffMs: 1_000 },
  {
    logger: { warn: write('warn'), error: write('error') },
    now: () => performance.now(),
    random: () => 0.5,
    sleep: (ms) => sleep(ms),
    start: () => {
      const child = spawn(
        process.execPath,
        [new URL('fixture-host.ts', import.meta.url).pathname, script],
        { env: process.env, stdio: ['ignore', 'inherit', 'inherit'] },
      );
      return {
        exited: new Promise((settle) => {
          child.once('exit', (code, signal) => {
            settle({ code, signal });
          });
        }),
        stop: () => {
          child.kill('SIGKILL');
        },
      };
    },
  },
);
process.once('SIGTERM', () => {
  supervisor.stop();
});
watchParent(() => {
  supervisor.stop();
});
await supervisor.run();

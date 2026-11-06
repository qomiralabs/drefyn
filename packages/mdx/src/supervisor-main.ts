import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { assertHostEnv, parseHostConfig } from './host-config.ts';
import { parseSupervisorConfig } from './supervisor-config.ts';
import { createSupervisor } from './supervisor.ts';
import type { HostExit, SupervisedHost } from './supervisor.ts';

const here = dirname(fileURLToPath(import.meta.url));
const code = resolve(here, '../../..');
const STOP_GRACE_MS = 10_000;

// A setting that can never work is refused here, once, rather than found by a crash loop.
if (!process.execArgv.includes('--permission')) {
  throw new Error('the parse supervisor runs only under --permission');
}
assertHostEnv(process.env);
parseHostConfig(process.env);

const write = (level: string) => (event: string, fields: object) => {
  process.stdout.write(`${JSON.stringify({ level, event, ...fields })}\n`);
};
const logger = { info: write('info'), warn: write('warn'), error: write('error') };

function startHost(): SupervisedHost {
  const child = spawn(
    process.execPath,
    ['--permission', `--allow-fs-read=${code}`, '--allow-worker', resolve(here, 'host-main.ts')],
    { env: process.env, stdio: ['ignore', 'inherit', 'inherit'] },
  );
  logger.info('mdx.parse_host_started', { pid: child.pid ?? 0 });
  const exited = new Promise<HostExit>((settle) => {
    child.once('exit', (exitCode, signal) => {
      settle({ code: exitCode, signal });
    });
  });
  return {
    exited,
    stop() {
      child.kill('SIGTERM');
      setTimeout(() => {
        child.kill('SIGKILL');
      }, STOP_GRACE_MS).unref();
    },
  };
}

const supervisor = createSupervisor(parseSupervisorConfig(process.env), {
  start: startHost,
  logger,
  now: () => performance.now(),
  random: () => randomInt(0, 1_000_000) / 1_000_000,
  sleep: (ms, signal) =>
    sleep(ms, undefined, { signal }).catch(() => {
      // Woken to stop, which the loop reads for itself.
    }),
});

process.once('SIGTERM', () => {
  supervisor.stop();
});

await supervisor.run();
process.exit(0);

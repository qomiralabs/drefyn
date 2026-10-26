import { spawn } from 'node:child_process';
import { composeFile, stack } from './stack.ts';

// Its own key, never the migrate key: tests take and wait on that one on purpose.
export const RUN_LOCK_KEY = '4207140014';

const TAKE_TIMEOUT_MS = 15_000;

export interface RunLock {
  release(): Promise<void>;
}

// A session advisory lock on the postgres database, held by a psql that stays open for the
// whole run. The superuser only logs in over the container socket, so it goes through exec.
// If the run dies, psql dies with it and Postgres releases the lock.
export function takeRunLock(): Promise<RunLock> {
  const { project } = stack();
  const child = spawn(
    'docker',
    [
      'compose',
      '-p',
      project,
      '-f',
      composeFile,
      'exec',
      '-T',
      'postgres',
      'psql',
      '--no-psqlrc',
      '-qAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'postgres',
    ],
    { env: { ...process.env, COMPOSE_PROJECT_NAME: project }, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const exited = new Promise<void>((resolve) =>
    child.on('close', () => {
      resolve();
    }),
  );
  const release = async () => {
    child.stdin.end();
    await exited;
  };

  return new Promise<RunLock>((resolve, reject) => {
    let out = '';
    let err = '';
    const fail = (why: string) => {
      clearTimeout(timer);
      child.kill();
      reject(new Error(why));
    };
    const timer = setTimeout(() => {
      fail(`could not take the integration run lock on compose project ${project} in time`);
    }, TAKE_TIMEOUT_MS);
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk));
    child.on('error', (error) => {
      fail(`could not start psql for the run lock: ${error.message}`);
    });
    child.on('close', (code) => {
      if (!out.includes('\n')) fail(`psql for the run lock exited ${String(code)}: ${err}`);
    });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      out += chunk;
      const answer = out.split('\n')[0];
      if (!out.includes('\n')) return;
      if (answer === 't') {
        clearTimeout(timer);
        resolve({ release });
      } else {
        fail(
          `another integration run holds the run lock on compose project ${project}; one run per stack at a time`,
        );
      }
    });
    child.stdin.write(`select pg_try_advisory_lock(${RUN_LOCK_KEY});\n`);
  });
}

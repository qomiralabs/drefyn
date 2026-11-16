import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtractAnswer, ExtractRequest } from '../../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, '../../../..');
const script = resolve(here, '../hosts/repo-host.ts');

export interface RepoHost {
  readonly process: ChildProcess;
  readonly permission: { child: boolean; worker: boolean; passwd: boolean };
  extract(request: ExtractRequest): Promise<ExtractAnswer>;
  kill(): void;
}

// The workspace is the read boundary here, as /app is in the image.
export async function startRepoHost(timeoutMs: number): Promise<RepoHost> {
  const child = spawn(
    process.execPath,
    ['--permission', `--allow-fs-read=${workspace}`, '--allow-worker', script, String(timeoutMs)],
    { env: {}, stdio: ['pipe', 'pipe', 'ignore'] },
  );
  const pending = new Map<number, (answer: ExtractAnswer) => void>();
  let ready: (permission: RepoHost['permission']) => void = () => undefined;
  const started = new Promise<RepoHost['permission']>((resolve, reject) => {
    ready = resolve;
    child.once('exit', () => {
      reject(new Error('the repo host stopped before it was ready'));
    });
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line) as {
      id?: number;
      answer?: ExtractAnswer;
      permission?: RepoHost['permission'];
    };
    if (message.permission !== undefined) ready(message.permission);
    if (message.id !== undefined && message.answer !== undefined) {
      pending.get(message.id)?.(message.answer);
      pending.delete(message.id);
    }
  });
  const permission = await started;
  let next = 0;
  return {
    process: child,
    permission,
    extract: (request) =>
      new Promise((resolve) => {
        next += 1;
        pending.set(next, resolve);
        child.stdin.write(`${JSON.stringify({ id: next, request })}\n`);
      }),
    kill: () => child.kill('SIGKILL'),
  };
}

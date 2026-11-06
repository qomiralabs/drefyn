import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const workspace = resolve(import.meta.dirname, '..', '..', '..', '..');
const hostMain = resolve(workspace, 'packages', 'mdx', 'src', 'host-main.ts');

// A test stack's own, and it never leaves it. The host keeps only the hash, as a deployment does.
export const PARSE_HOST_TOKEN = 'engine-tests-only-parse-host-bearer-value';
const quiet = { warn: () => undefined };
export const parseClientConfig = (url: string) => ({
  url,
  token: PARSE_HOST_TOKEN,
  logger: quiet,
});

export interface RunningHost {
  readonly url: string;
  readonly host: ChildProcess;
}

// The real host, started the way an operator starts it. It prints one line with its port.
export function startHost(): Promise<RunningHost> {
  const host = spawn(
    process.execPath,
    ['--permission', `--allow-fs-read=${workspace}`, '--allow-worker', hostMain],
    {
      env: {
        DREFYN_PARSE_PORT: '0',
        DREFYN_PARSE_TOKEN_SHA256: createHash('sha256').update(PARSE_HOST_TOKEN).digest('hex'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return new Promise((done, fail) => {
    let text = '';
    host.stdout.on('data', (chunk: Buffer) => {
      text += chunk.toString();
      const port = /"port":(\d+)/.exec(text)?.[1];
      if (port !== undefined) done({ url: `http://127.0.0.1:${port}`, host });
    });
    host.once('exit', () => {
      fail(new Error('the parse host stopped before it listened'));
    });
  });
}

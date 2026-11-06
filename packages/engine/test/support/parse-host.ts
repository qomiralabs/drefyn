import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

const workspace = resolve(import.meta.dirname, '..', '..', '..', '..');
const hostMain = resolve(workspace, 'packages', 'mdx', 'src', 'host-main.ts');

export interface RunningHost {
  readonly url: string;
  readonly host: ChildProcess;
}

// The real host, started the way an operator starts it. It prints one line with its port.
export function startHost(): Promise<RunningHost> {
  const host = spawn(
    process.execPath,
    ['--permission', `--allow-fs-read=${workspace}`, '--allow-worker', hostMain],
    { env: { DREFYN_PARSE_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] },
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

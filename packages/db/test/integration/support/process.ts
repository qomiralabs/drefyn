import { spawn, type ChildProcess } from 'node:child_process';

export interface Finished {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface Running {
  readonly child: ChildProcess;
  readonly done: Promise<Finished>;
  exited(): boolean;
}

export function start(
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string; input?: string } = {},
): Running {
  const child = spawn(command, args, {
    env: options.env ?? process.env,
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let exited = false;
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const done = new Promise<Finished>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      exited = true;
      resolve({ code, stdout, stderr });
    });
  });
  child.stdin.end(options.input ?? '');
  return { child, done, exited: () => exited };
}

export function run(
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string; input?: string } = {},
): Promise<Finished> {
  return start(command, args, options).done;
}

// Waits for a condition another process brings about. It polls with a deadline rather than
// sleeping a fixed time, and gives up at once if the process it is watching has exited.
export async function until(
  condition: () => Promise<boolean>,
  options: { timeoutMs: number; watching?: Running; what: string },
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (options.watching?.exited()) {
      const finished = await options.watching.done;
      throw new Error(
        `${options.what}: the process exited ${String(finished.code)} first\n${finished.stderr}`,
      );
    }
    if (Date.now() > deadline) throw new Error(`${options.what}: timed out`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

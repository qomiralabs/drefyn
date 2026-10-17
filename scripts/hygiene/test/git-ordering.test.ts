import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Real git only loses this race under heavy load, so a fake child lets each test pick
// the order in which the process closes and stdin fails or finishes.
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin: Writable | null;
  private pending: ((error?: Error | null) => void) | undefined;

  constructor(withStdin: boolean) {
    super();
    this.stdin = withStdin
      ? new Writable({
          write: (_chunk, _encoding, callback) => {
            this.pending = callback;
          },
        })
      : null;
  }

  async failStdin(code = 'EPIPE'): Promise<void> {
    const error = Object.assign(new Error(`write ${code}`), { code });
    this.release(error);
    await settle();
  }

  async finishStdin(): Promise<void> {
    this.release(null);
    await settle();
  }

  async exit(code: number, stdout = '', stderr = ''): Promise<void> {
    this.stdout.end(stdout);
    this.stderr.end(stderr);
    await settle();
    this.emit('close', code);
    await settle();
  }

  private release(error: Error | null): void {
    const callback = this.pending;
    if (callback === undefined) throw new Error('nothing was written to stdin');
    this.pending = undefined;
    callback(error);
  }
}

// Stream events fire on later ticks, so give them a turn before checking the promise.
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

let child: FakeChild;
const spawn = vi.fn((_command: string, _args: string[], options: { stdio: string[] }) => {
  child = new FakeChild(options.stdio[0] === 'pipe');
  return child;
});

vi.mock('node:child_process', () => ({ spawn }));

const { runGit } = await import('../src/git.ts');

function track<T>(promise: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  return { promise, settled: () => done };
}

beforeEach(() => {
  spawn.mockClear();
});

describe('runGit settles only after the process and stdin are both done', () => {
  it('rejects when stdin fails after git already closed with exit 0', async () => {
    const run = track(runGit('/repo', ['--version'], 'input'));
    await settle();
    await child.exit(0, 'git version 2.50.0\n');
    expect(run.settled()).toBe(false);
    await child.failStdin();
    await expect(run.promise).rejects.toThrow(/git --version closed its input early: write EPIPE/);
  });

  it('rejects when stdin fails before git closes with exit 0', async () => {
    const run = track(runGit('/repo', ['--version'], 'input'));
    await settle();
    await child.failStdin();
    expect(run.settled()).toBe(false);
    await child.exit(0, 'git version 2.50.0\n');
    await expect(run.promise).rejects.toThrow(/git --version closed its input early/);
  });

  it('waits for stdin to finish when git closes first, then returns the output', async () => {
    const run = track(runGit('/repo', ['cat-file', '--batch'], 'abc\n'));
    await settle();
    await child.exit(0, 'out');
    expect(run.settled()).toBe(false);
    await child.finishStdin();
    await expect(run.promise).resolves.toEqual(Buffer.from('out'));
  });

  it('returns the output when stdin finishes before git closes', async () => {
    const run = track(runGit('/repo', ['cat-file', '--batch'], 'abc\n'));
    await settle();
    await child.finishStdin();
    expect(run.settled()).toBe(false);
    await child.exit(0, 'out');
    await expect(run.promise).resolves.toEqual(Buffer.from('out'));
  });

  it('reports the exit code and stderr when git fails, whatever stdin did', async () => {
    const run = track(runGit('/repo', ['cat-file', '--no-such-flag'], 'input'));
    await settle();
    await child.exit(128, '', 'error: unknown option\n');
    await child.failStdin();
    await expect(run.promise).rejects.toThrow(
      /git cat-file failed \(exit 128\): error: unknown option$/,
    );
  });

  it('settles on close alone when there is no input', async () => {
    const run = track(runGit('/repo', ['--version']));
    await settle();
    expect(spawn.mock.calls[0]?.[2].stdio[0]).toBe('ignore');
    await child.exit(0, 'git version 2.50.0\n');
    await expect(run.promise).resolves.toEqual(Buffer.from('git version 2.50.0\n'));
  });

  it('rejects with the spawn error and ignores the events that follow it', async () => {
    const run = track(runGit('/repo', ['--version'], 'input'));
    await settle();
    const error = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    child.emit('error', error);
    await child.failStdin();
    await child.exit(0);
    await expect(run.promise).rejects.toBe(error);
  });
});

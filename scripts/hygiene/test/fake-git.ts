import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

export interface SpawnCall {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
}

export type Responder = (args: string[]) => { code?: number; stdout?: string | Buffer };

// Answers each spawn from a script instead of real git, so tests can feed git output
// that real git would never produce and record exactly how git was started.
class ScriptedChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin: Writable | null;

  constructor(withStdin: boolean, code: number, stdout: Buffer) {
    super();
    const reply = (): void => {
      this.stdout.end(stdout);
      this.stderr.end();
      setImmediate(() => this.emit('close', code));
    };
    if (withStdin) {
      this.stdin = new Writable({
        write: (_chunk, _encoding, callback) => {
          callback();
        },
      });
      this.stdin.on('finish', reply);
    } else {
      this.stdin = null;
      setImmediate(reply);
    }
  }
}

export function scriptedSpawn(respond: Responder): {
  spawn: (
    command: string,
    args: string[],
    options: { stdio: string[]; env?: NodeJS.ProcessEnv },
  ) => ScriptedChild;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  return {
    calls,
    spawn(command, args, options) {
      calls.push({ command, args, env: options.env });
      const { code = 0, stdout = '' } = respond(args);
      return new ScriptedChild(
        options.stdio[0] === 'pipe',
        code,
        typeof stdout === 'string' ? Buffer.from(stdout, 'utf8') : stdout,
      );
    },
  };
}

// The subcommand is whatever follows the global options runGit puts in front.
export function subcommand(args: string[]): string[] {
  const at = args.findIndex(
    (arg) => arg === 'ls-files' || arg === 'cat-file' || arg === 'log' || arg === 'rev-parse',
  );
  return at === -1 ? args : args.slice(at);
}

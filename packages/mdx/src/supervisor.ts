import type { SupervisorConfig } from './supervisor-config.ts';

export interface HostExit {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface SupervisedHost {
  readonly exited: Promise<HostExit>;
  stop(): void;
}

type Fields = Readonly<Record<string, string | number>>;

export interface SupervisorLogger {
  info?(event: string, fields: Fields): void;
  warn(event: string, fields: Fields): void;
  // What an alert is set on: someone has to look at this.
  error(event: string, fields: Fields): void;
}

export interface SupervisorDeps {
  readonly start: () => SupervisedHost;
  readonly logger: SupervisorLogger;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly now: () => number;
  readonly random: () => number;
}

export interface Supervisor {
  // Resolves only once stopped. A host that ends without being asked is always restarted.
  run(): Promise<void>;
  stop(): void;
}

// A host that dies is routine: the pool kills it for a stuck thread and a thread can abort it.
// One that keeps dying is a page or a bug repeating, and every restart costs every tenant on it
// their pages in flight. So restarts back off, and a loop stops for a while and tells someone.
export function createSupervisor(config: SupervisorConfig, deps: SupervisorDeps): Supervisor {
  const { backoffMs, maxBackoffMs, crashLimit, crashWindowMs, coolOffMs } = config;
  const stopping = new AbortController();
  let running: SupervisedHost | undefined;

  const log = (level: 'info' | 'warn' | 'error', event: string, fields: Fields) => {
    try {
      deps.logger[level]?.(event, fields);
    } catch {
      // A log line is never worth a host left down.
    }
  };

  // Half is fixed, so a burst of crashes still spaces out, and half is random, so replicas that
  // died together do not come back together.
  const backoff = (crashes: number) => {
    const ceiling = Math.min(maxBackoffMs, backoffMs * 2 ** (crashes - 1));
    return Math.ceil(ceiling / 2 + (deps.random() * ceiling) / 2);
  };

  const run = async () => {
    let crashes: number[] = [];
    while (!stopping.signal.aborted) {
      running = deps.start();
      const { code, signal } = await running.exited;
      running = undefined;
      if (stopping.signal.aborted) return;

      const at = deps.now();
      crashes = [...crashes.filter((crash) => at - crash < crashWindowMs), at];
      const ended = { code: code ?? 'none', signal: signal ?? 'none', crashes: crashes.length };
      if (crashes.length >= crashLimit) {
        log('error', 'mdx.parse_host_crash_loop', { ...ended, crashWindowMs, coolOffMs });
        await deps.sleep(coolOffMs, stopping.signal);
        crashes = [];
      } else {
        const wait = backoff(crashes.length);
        log('warn', 'mdx.parse_host_crashed', { ...ended, backoffMs: wait });
        await deps.sleep(wait, stopping.signal);
      }
    }
  };

  return {
    run,
    stop() {
      stopping.abort();
      running?.stop();
    },
  };
}

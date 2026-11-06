import { describe, expect, it } from 'vitest';
import { parseSupervisorConfig } from '../src/supervisor-config.ts';
import { createSupervisor } from '../src/supervisor.ts';
import type { HostExit, SupervisedHost, SupervisorDeps } from '../src/supervisor.ts';
import { recordingLogger } from './helpers.ts';

const flush = async () => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};

const CONFIG = {
  backoffMs: 100,
  maxBackoffMs: 1_000,
  crashLimit: 4,
  crashWindowMs: 60_000,
  coolOffMs: 300_000,
};
const KILLED: HostExit = { code: null, signal: 'SIGKILL' };

function harness(overrides: Partial<SupervisorDeps> = {}) {
  const logger = recordingLogger();
  const clock = { now: 0 };
  const hosts: { end: (exit: HostExit) => void; stopped: number }[] = [];
  const naps: { ms: number; wake: () => void }[] = [];
  const supervisor = createSupervisor(CONFIG, {
    logger: {
      warn: (event, fields) => {
        logger.warn(event, fields);
      },
      error: (event, fields) => {
        logger.warn(event, fields);
      },
    },
    now: () => clock.now,
    random: () => 1,
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        naps.push({ ms, wake: resolve });
        signal.addEventListener('abort', () => {
          resolve();
        });
      }),
    start: () => {
      const entry = { end: (_exit: HostExit) => undefined as void, stopped: 0 };
      const exited = new Promise<HostExit>((resolve) => {
        entry.end = resolve;
      });
      hosts.push(entry);
      const host: SupervisedHost = {
        exited,
        stop: () => {
          entry.stopped += 1;
          entry.end({ code: 0, signal: null });
        },
      };
      return host;
    },
    ...overrides,
  });
  // Ends the running host and sleeps through whatever comes next.
  const crash = async (exit: HostExit = KILLED) => {
    hosts.at(-1)?.end(exit);
    await flush();
  };
  const wake = async () => {
    naps.shift()?.wake();
    await flush();
  };
  return { supervisor, logger, clock, hosts, naps, crash, wake };
}

describe('the supervisor', () => {
  it('starts the host at once', async () => {
    const { supervisor, hosts } = harness();
    void supervisor.run();
    await flush();
    expect(hosts).toHaveLength(1);
  });

  it('restarts a killed host, after a backoff and not straight away', async () => {
    const { supervisor, hosts, naps, crash, wake } = harness();
    void supervisor.run();
    await flush();
    await crash();
    expect(hosts).toHaveLength(1);
    expect(naps.map(({ ms }) => ms)).toEqual([100]);
    await wake();
    expect(hosts).toHaveLength(2);
  });

  it('doubles the wait with each crash', async () => {
    const { supervisor, naps, crash, wake } = harness();
    void supervisor.run();
    await flush();
    const waits: number[] = [];
    for (let crashes = 0; crashes < 3; crashes += 1) {
      await crash();
      waits.push(naps[0]?.ms ?? 0);
      await wake();
    }
    expect(waits).toEqual([100, 200, 400]);
  });

  it('never waits past its ceiling', async () => {
    const waits: number[] = [];
    let stop = () => undefined as void;
    const supervisor = createSupervisor(
      { ...CONFIG, crashLimit: 100 },
      {
        logger: { warn: () => undefined, error: () => undefined },
        now: () => 0,
        random: () => 1,
        sleep: (ms) => {
          waits.push(ms);
          if (waits.length === 20) stop();
          return Promise.resolve();
        },
        start: () => ({ exited: Promise.resolve(KILLED), stop: () => undefined }),
      },
    );
    stop = supervisor.stop;
    await supervisor.run();
    expect(waits).toHaveLength(20);
    expect(Math.max(...waits)).toBe(1_000);
  });

  it('jitters each wait between half and all of it', async () => {
    const { supervisor, naps, crash } = harness({ random: () => 0 });
    void supervisor.run();
    await flush();
    await crash();
    expect(naps[0]?.ms).toBe(50);
  });

  it('reports a crash with its signal and exit code', async () => {
    const { supervisor, logger, crash } = harness();
    void supervisor.run();
    await flush();
    await crash({ code: 134, signal: null });
    expect(logger.entries).toContainEqual({
      level: 'warn',
      event: 'mdx.parse_host_crashed',
      fields: { code: 134, signal: 'none', crashes: 1, backoffMs: 100 },
    });
  });

  it('alerts and stays down on a crash loop, rather than restart tightly', async () => {
    const { supervisor, logger, hosts, naps, crash, wake } = harness();
    void supervisor.run();
    await flush();
    for (let crashes = 0; crashes < 3; crashes += 1) {
      await crash();
      await wake();
    }
    await crash();
    expect(logger.entries.map(({ event }) => event)).toContain('mdx.parse_host_crash_loop');
    expect(naps.map(({ ms }) => ms)).toEqual([300_000]);
    expect(hosts).toHaveLength(4);
    await wake();
    expect(hosts).toHaveLength(5);
  });

  it('starts counting again after the cool off', async () => {
    const { supervisor, naps, crash, wake } = harness();
    void supervisor.run();
    await flush();
    for (let crashes = 0; crashes < 3; crashes += 1) {
      await crash();
      await wake();
    }
    await crash();
    await wake();
    await crash();
    expect(naps.map(({ ms }) => ms)).toEqual([100]);
  });

  it('forgets crashes older than its window, so a rare one stays cheap', async () => {
    const { supervisor, clock, naps, crash, wake } = harness();
    void supervisor.run();
    await flush();
    for (let round = 0; round < 8; round += 1) {
      await crash();
      expect(naps.map(({ ms }) => ms)).toEqual([100]);
      await wake();
      clock.now += CONFIG.crashWindowMs;
    }
  });

  it('stops the host, and does not restart one it stopped', async () => {
    const { supervisor, hosts } = harness();
    const running = supervisor.run();
    await flush();
    supervisor.stop();
    await running;
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.stopped).toBe(1);
  });

  it('wakes from a backoff or a cool off to stop', async () => {
    const { supervisor, hosts, crash } = harness();
    const running = supervisor.run();
    await flush();
    await crash();
    supervisor.stop();
    await running;
    expect(hosts).toHaveLength(1);
  });

  it('can be stopped twice, and before it runs', async () => {
    const { supervisor, hosts } = harness();
    supervisor.stop();
    supervisor.stop();
    await supervisor.run();
    expect(hosts).toHaveLength(0);
  });

  it('survives a logger that throws', async () => {
    const broken = () => {
      throw new Error('no sink');
    };
    const { supervisor, hosts, crash, wake } = harness({
      logger: { warn: broken, error: broken, info: broken },
    });
    void supervisor.run();
    await flush();
    await crash();
    await wake();
    expect(hosts).toHaveLength(2);
  });
});

describe('the supervisor config', () => {
  it('has defaults a crash loop can trip within a minute', () => {
    const { backoffMs, maxBackoffMs, crashLimit, crashWindowMs, coolOffMs } = parseSupervisorConfig(
      {},
    );
    let spent = 0;
    for (let crash = 1; crash < crashLimit; crash += 1) {
      spent += Math.min(maxBackoffMs, backoffMs * 2 ** (crash - 1));
    }
    expect(spent).toBeLessThan(crashWindowMs);
    expect(coolOffMs).toBeGreaterThan(crashWindowMs);
  });

  it('reads the environment', () => {
    expect(parseSupervisorConfig({ DREFYN_PARSE_CRASH_LIMIT: '9' }).crashLimit).toBe(9);
  });

  it.each(['0', 'many', '-1'])('refuses %j', (value) => {
    expect(() => parseSupervisorConfig({ DREFYN_PARSE_CRASH_LIMIT: value })).toThrow();
  });

  it('refuses a backoff over its own ceiling', () => {
    expect(() =>
      parseSupervisorConfig({
        DREFYN_PARSE_RESTART_BACKOFF_MS: '2000',
        DREFYN_PARSE_RESTART_MAX_MS: '1000',
      }),
    ).toThrow();
  });
});

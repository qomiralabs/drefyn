import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIMITS } from '../src/index.ts';
import type { ParseResult } from '../src/index.ts';
import { createParsePool } from '../src/isolated.ts';
import type { ParseRequest } from '../src/isolated.ts';
import { RECYCLE_AFTER_JOBS } from '../src/thread.ts';
import type { ParseThread, ThreadAnswer } from '../src/thread.ts';
import {
  isolatedPolicy,
  ORG_A,
  POOL_CONFIG,
  PROJECT_A,
  PROJECT_B,
  projectAt,
  recordingLogger,
} from './helpers.ts';

const flush = async () => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};

// Any object will do: the pool hands back whatever the thread answered.
const OK: ParseResult = { ok: false, error: [] };
const timedOut: ThreadAnswer = {
  result: {
    ok: false,
    error: [{ code: 'mdx.parse_timeout', severity: 'error', line: 1, column: 1 }],
  },
  end: 'killed',
  workMs: 0,
};
const done: ThreadAnswer = { result: OK, end: 'reusable', workMs: 0 };
const spending = (workMs: number): ThreadAnswer => ({ ...timedOut, workMs });

class FakeThread implements ParseThread {
  readonly jobs: ((answer: ThreadAnswer) => void)[] = [];
  readonly sources: string[] = [];
  isAlive = true;
  stopped = 0;
  leaveGone: () => void = () => undefined;
  readonly gone = new Promise<void>((resolve) => {
    this.leaveGone = resolve;
  });

  run(job: { source: string }) {
    this.sources.push(job.source);
    return new Promise<ThreadAnswer>((resolve) => {
      this.jobs.push(resolve);
    });
  }
  alive() {
    return this.isAlive;
  }
  stop() {
    this.stopped += 1;
    return Promise.resolve();
  }
}

function harness(config: Partial<typeof POOL_CONFIG> = {}) {
  const threads: FakeThread[] = [];
  const logger = recordingLogger();
  const clock = { now: 0 };
  const pool = createParsePool(
    { ...POOL_CONFIG, ...config },
    {
      logger,
      now: () => clock.now,
      startThread: () => {
        const thread = new FakeThread();
        threads.push(thread);
        return thread;
      },
    },
  );
  // The oldest job still waiting on any thread.
  const finish = async (answer: ThreadAnswer = done) => {
    const thread = threads.find(({ jobs }) => jobs.length > 0);
    const job = thread?.jobs.shift();
    if (job === undefined) throw new Error('nothing running');
    job(answer);
    await flush();
  };
  return { pool, threads, logger, clock, finish };
}

const request = (projectId = PROJECT_A, source = 'page'): ParseRequest => ({
  organizationId: ORG_A,
  projectId,
  path: 'docs/page.md',
  source,
  dialect: 'md',
  policy: isolatedPolicy(),
});

const limitsPolicy = () => ({
  ...isolatedPolicy(),
  limits: { ...DEFAULT_LIMITS, maxBytes: 3 },
});

const codeOf = async (result: Promise<ParseResult>) => {
  const settled = await result;
  return settled.ok ? 'ok' : settled.error[0]?.code;
};

describe('the queue', () => {
  it('takes jobs up to its limit and refuses the next one', async () => {
    const { pool, threads, finish } = harness({
      threads: 3,
      projectThreads: 2,
      maxQueued: 2,
      maxQueuedPerProject: 2,
    });
    const running = [pool.parse(request(PROJECT_A)), pool.parse(request(PROJECT_A))];
    const other = pool.parse(request(PROJECT_B));
    await flush();
    expect(threads).toHaveLength(3);
    const queued = [pool.parse(request(PROJECT_A)), pool.parse(request(PROJECT_B))];
    await flush();
    expect(pool.stats().queued).toBe(2);
    expect(await codeOf(pool.parse(request(projectAt(1))))).toBe('mdx.queue_full');
    expect(pool.stats().queued).toBe(2);
    for (let left = 5; left > 0; left -= 1) await finish();
    await Promise.all([...running, other, ...queued]);
    expect(pool.stats()).toMatchObject({ busy: 0, queued: 0 });
  });

  it('holds a page over the size limit out of the queue and off a thread', async () => {
    const { pool, threads } = harness();
    const small = { ...request(), policy: limitsPolicy() };
    await expect(codeOf(pool.parse({ ...small, source: 'four' }))).resolves.toBe('mdx.too_large');
    expect(threads).toEqual([]);
  });
});

describe('page size', () => {
  it('counts UTF-8 bytes, at the limit and one over', async () => {
    const { pool, finish } = harness();
    const fits = pool.parse({ ...request(), source: 'a\u00e9', policy: limitsPolicy() });
    await flush();
    await finish();
    expect(await fits).toBe(OK);
    const over = { ...request(), source: '\u00e9\u00e9', policy: limitsPolicy() };
    await expect(codeOf(pool.parse(over))).resolves.toBe('mdx.too_large');
  });
});

describe('the per project limits', () => {
  it('keeps one project on its share of the threads', async () => {
    const { pool, threads, finish } = harness();
    const pages = [pool.parse(request()), pool.parse(request()), pool.parse(request())];
    await flush();
    expect(threads).toHaveLength(1);
    expect(pool.stats()).toMatchObject({ busy: 1, queued: 2 });
    const neighbour = pool.parse(request(PROJECT_B));
    await flush();
    expect(threads).toHaveLength(2);
    expect(pool.stats().busy).toBe(2);
    for (let left = 4; left > 0; left -= 1) await finish();
    await Promise.all([...pages, neighbour]);
  });

  it('takes a project up to its queue limit and refuses the next one', async () => {
    const { pool, finish } = harness({ maxQueuedPerProject: 2 });
    const running = pool.parse(request());
    const queued = [pool.parse(request()), pool.parse(request())];
    await flush();
    expect(await codeOf(pool.parse(request()))).toBe('mdx.project_limit');
    const neighbour = pool.parse(request(PROJECT_B));
    for (let left = 4; left > 0; left -= 1) await finish();
    await Promise.all([running, ...queued, neighbour]);
  });

  it('serves projects in turn, so a big repo cannot starve a small one', async () => {
    const { pool, threads, finish } = harness({
      threads: 2,
      maxQueuedPerProject: 8,
      maxQueued: 16,
    });
    const blockers = [pool.parse(request(PROJECT_A, 'a0')), pool.parse(request(projectAt(1)))];
    await flush();
    const big = [1, 2, 3].map((index) => pool.parse(request(PROJECT_A, `a${index}`)));
    const small = pool.parse(request(PROJECT_B, 'b0'));
    await flush();
    await finish();
    await finish();
    await finish();
    const order = threads.flatMap(({ sources }) => sources);
    expect(order.indexOf('b0')).toBeGreaterThan(-1);
    expect(order).not.toContain('a3');
    for (let left = 3; left > 0; left -= 1) await finish();
    await Promise.all([...blockers, ...big, small]);
  });

  it('refuses a project that spent its budget, and only that project', async () => {
    const { pool, finish } = harness({
      projectBudgetMs: 2_000,
      projectWindowMs: 10_000,
      timeoutMs: 1_000,
    });
    const first = pool.parse(request());
    const second = pool.parse(request());
    await flush();
    await finish(spending(1_999));
    expect(await codeOf(first)).toBe('mdx.parse_timeout');
    await finish(spending(1));
    expect(await codeOf(second)).toBe('mdx.parse_timeout');

    expect(await codeOf(pool.parse(request()))).toBe('mdx.project_limit');
    const neighbour = pool.parse(request(PROJECT_B));
    await flush();
    await finish();
    expect(await neighbour).toBe(OK);
  });

  it('refuses waiting pages once the budget runs out, without a thread', async () => {
    const { pool, threads, finish } = harness({
      projectBudgetMs: 1_000,
      projectWindowMs: 10_000,
    });
    const first = pool.parse(request());
    const queued = [pool.parse(request()), pool.parse(request())];
    await flush();
    await finish(spending(1_000));
    await first;
    expect(await Promise.all(queued.map(codeOf))).toEqual([
      'mdx.project_limit',
      'mdx.project_limit',
    ]);
    expect(threads.flatMap(({ sources }) => sources)).toHaveLength(1);
    expect(pool.stats().queued).toBe(0);
  });

  it('gives the budget back in the next window', async () => {
    const { pool, clock, finish } = harness({ projectBudgetMs: 1_000, projectWindowMs: 10_000 });
    const first = pool.parse(request());
    await flush();
    clock.now += 1_000;
    await finish(spending(1_000));
    await first;
    expect(await codeOf(pool.parse(request()))).toBe('mdx.project_limit');
    clock.now += 9_000;
    const again = pool.parse(request());
    await flush();
    await finish();
    expect(await again).toBe(OK);
  });

  it('does not charge a project for a thread that was slow to start', async () => {
    const { pool, clock, finish } = harness({ projectBudgetMs: 1_000, projectWindowMs: 10_000 });
    const first = pool.parse(request());
    await flush();
    clock.now += 5_000;
    await finish(spending(1));
    await first;
    const second = pool.parse(request());
    await flush();
    await finish();
    expect(await second).toBe(OK);
  });

  it('forgets a project once its window has passed', async () => {
    const { pool, clock, finish } = harness({ projectWindowMs: 10_000, projectBudgetMs: 5_000 });
    for (let index = 0; index < 20; index += 1) {
      const page = pool.parse(request(projectAt(index)));
      await flush();
      await finish();
      await page;
    }
    expect(pool.stats().projects).toBe(20);
    clock.now += 10_000;
    const last = pool.parse(request(PROJECT_B));
    expect(pool.stats().projects).toBe(1);
    await flush();
    await finish();
    await last;
  });
});

describe('threads', () => {
  it('never retries a page that was killed', async () => {
    const { pool, threads, finish } = harness();
    const page = pool.parse(request());
    await flush();
    await finish(timedOut);
    expect(await codeOf(page)).toBe('mdx.parse_timeout');
    expect(threads.flatMap(({ sources }) => sources)).toHaveLength(1);
  });

  it('starts a new thread after a kill', async () => {
    const { pool, threads, finish } = harness();
    const first = pool.parse(request());
    await flush();
    await finish(timedOut);
    await first;
    expect(pool.stats().threads).toBe(0);
    const second = pool.parse(request());
    await flush();
    await finish();
    await second;
    expect(threads).toHaveLength(2);
    expect(pool.stats().threads).toBe(1);
  });

  it('skips an idle thread that died', async () => {
    const { pool, threads, finish } = harness();
    const first = pool.parse(request());
    await flush();
    await finish();
    await first;
    const [dead] = threads;
    if (dead === undefined) throw new Error('no thread');
    dead.isAlive = false;
    const second = pool.parse(request());
    await flush();
    await finish();
    await second;
    expect(threads).toHaveLength(2);
    expect(dead.sources).toHaveLength(1);
  });

  it('retires a thread after a fixed number of jobs', async () => {
    const { pool, threads, finish } = harness({ projectBudgetMs: 60_000 });
    for (let count = 0; count < RECYCLE_AFTER_JOBS; count += 1) {
      const page = pool.parse(request());
      await flush();
      await finish();
      await page;
    }
    expect(threads[0]?.stopped).toBe(1);
    expect(pool.stats().threads).toBe(0);
  });

  it('answers cleanly when a thread cannot start', async () => {
    const logger = recordingLogger();
    const pool = createParsePool(POOL_CONFIG, {
      logger,
      startThread: () => {
        throw new Error('out of threads');
      },
    });
    expect(await codeOf(pool.parse(request()))).toBe('mdx.parse_unavailable');
    expect(pool.stats()).toMatchObject({ busy: 0, threads: 0 });
    expect(JSON.stringify(logger.entries)).not.toContain('out of threads');
  });

  it('answers cleanly when a thread rejects', async () => {
    const thread = new FakeThread();
    vi.spyOn(thread, 'run').mockRejectedValue(new Error('broken'));
    const pool = createParsePool(POOL_CONFIG, {
      logger: recordingLogger(),
      startThread: () => thread,
    });
    expect(await codeOf(pool.parse(request()))).toBe('mdx.parse_unavailable');
  });

  it('keeps the slot of a thread that will not die, so threads never pile up', async () => {
    const stuck: ThreadAnswer = { ...timedOut, end: 'stuck' };
    const { pool, threads, logger, finish } = harness();
    const first = pool.parse(request());
    await flush();
    await finish(stuck);
    expect(await codeOf(first)).toBe('mdx.parse_timeout');
    expect(pool.stats()).toMatchObject({ stuck: 1, threads: 1 });
    expect(logger.entries.map(({ event }) => event)).toContain('mdx.parse_thread_stuck');

    const second = pool.parse(request());
    await flush();
    expect(threads).toHaveLength(2);
    const third = pool.parse(request(PROJECT_B));
    await flush();
    expect(threads).toHaveLength(2);
    expect(pool.stats()).toMatchObject({ busy: 1, queued: 1 });

    threads[0]?.leaveGone();
    await flush();
    expect(pool.stats()).toMatchObject({ stuck: 0, busy: 2, queued: 0 });
    await finish();
    await finish();
    await Promise.all([second, third]);
  });

  it('refuses rather than hangs when every thread is stuck', async () => {
    const stuck: ThreadAnswer = { ...timedOut, end: 'stuck' };
    const { pool, finish } = harness();
    const pages = [pool.parse(request()), pool.parse(request(PROJECT_B))];
    const waiting = pool.parse(request());
    await flush();
    await finish(stuck);
    await finish(stuck);
    await Promise.all(pages);
    await flush();
    expect(await codeOf(waiting)).toBe('mdx.parse_unavailable');
    expect(await codeOf(pool.parse(request(projectAt(1))))).toBe('mdx.parse_unavailable');
  });
});

describe('closing', () => {
  it('refuses the queue, lets running work end and stops the threads', async () => {
    const { pool, threads, finish } = harness();
    const running = pool.parse(request());
    const queued = pool.parse(request());
    await flush();
    const closed = pool.close();
    expect(await codeOf(queued)).toBe('mdx.parse_unavailable');
    await finish();
    await running;
    await closed;
    expect(threads[0]?.stopped).toBe(1);
    expect(pool.stats().threads).toBe(0);
    expect(await codeOf(pool.parse(request()))).toBe('mdx.parse_unavailable');
  });
});

describe('logs', () => {
  it('carry tenant, path, hash and counts, and never the page', async () => {
    const { pool, logger, finish } = harness();
    const page = pool.parse(request(PROJECT_A, 'CANARY-PAGE-TEXT'));
    await flush();
    await finish(timedOut);
    await page;
    const entry = logger.entries.find(({ event }) => event === 'mdx.parse_refused');
    expect(entry).toMatchObject({
      level: 'warn',
      fields: {
        organizationId: ORG_A,
        projectId: PROJECT_A,
        path: 'docs/page.md',
        bytes: 16,
        code: 'mdx.parse_timeout',
      },
    });
    expect(entry?.fields['sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(logger.entries)).not.toContain('CANARY');
  });

  it('record a finished parse', async () => {
    const { pool, logger, finish } = harness();
    const page = pool.parse(request());
    await flush();
    await finish({
      result: { ok: true, value: { ast: {} as never, issues: [] } },
      end: 'reusable',
      workMs: 1,
    });
    await page;
    expect(logger.entries.map(({ event }) => event)).toEqual(['mdx.parse_finished']);
  });

  it('never fail a parse when the logger throws', async () => {
    const pool = createParsePool(POOL_CONFIG, {
      logger: {
        warn() {
          throw new Error('sink down');
        },
      },
      startThread: () => new FakeThread(),
    });
    const small = { ...request(), source: 'four', policy: limitsPolicy() };
    await expect(codeOf(pool.parse(small))).resolves.toBe('mdx.too_large');
  });
});

describe('input', () => {
  const bad: readonly [string, Partial<Record<keyof ParseRequest, unknown>>][] = [
    ['an organization id that is not one', { organizationId: 'x:y' }],
    ['a project id that is not one', { projectId: 'x:y' }],
    ['an empty path', { path: '' }],
    ['an endless path', { path: 'a'.repeat(4_097) }],
    ['a bad dialect', { dialect: 'html' }],
    [
      'a registry that cannot cross to a thread',
      { policy: { ...isolatedPolicy(), components: {} } },
    ],
  ];
  it.each(bad)('rejects %s, which is our bug and not bad content', async (_name, change) => {
    const { pool, threads } = harness();
    await expect(pool.parse({ ...request(), ...change } as ParseRequest)).rejects.toThrow();
    expect(threads).toEqual([]);
  });
});

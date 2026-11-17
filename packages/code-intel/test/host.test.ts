import { describe, expect, it, vi } from 'vitest';
import { createExtractHost, DEFAULT_EXTRACT_CONFIG } from '../src/index.ts';
import type { ExtractRequest } from '../src/index.ts';
import type { ExtractThread, ThreadRun } from '../src/thread.ts';
import { recordingLogger, TENANT } from './helpers.ts';

const request = (source = 'export const a = 1;', path = 'src/a.ts'): ExtractRequest => ({
  tenant: TENANT,
  path,
  language: 'typescript',
  source,
});

const done: ThreadRun = {
  answer: { ok: true, value: { symbols: [], routes: [], partial: false } },
  end: 'reusable',
  workMs: 1,
};

// Threads that answer when told to, so queue order and limits can be seen.
function heldThreads() {
  const held: ((run: ThreadRun) => void)[] = [];
  const stopped: number[] = [];
  let started = 0;
  const startThread = (): ExtractThread => {
    started += 1;
    const id = started;
    return {
      run: () =>
        new Promise((resolve) => {
          held.push(resolve);
        }),
      stop: () => {
        stopped.push(id);
        return Promise.resolve();
      },
    };
  };
  return { held, stopped, startThread, started: () => started };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('the extract host', () => {
  it('runs one file at a time, in order', async () => {
    const threads = heldThreads();
    const { logger } = recordingLogger();
    const host = createExtractHost(DEFAULT_EXTRACT_CONFIG, {
      logger,
      onStuck: vi.fn(),
      startThread: threads.startThread,
    });
    const first = host.extract(request('a', 'a.ts'));
    const second = host.extract(request('b', 'b.ts'));
    await flush();
    expect(threads.held).toHaveLength(1);
    expect(host.stats()).toEqual({ queued: 1, running: true, threadsStarted: 1 });
    threads.held[0]?.(done);
    expect(await first).toEqual(done.answer);
    await flush();
    threads.held[1]?.(done);
    expect(await second).toEqual(done.answer);
    expect(threads.started()).toBe(1);
  });

  it('refuses past the queue bound without running the file', async () => {
    const threads = heldThreads();
    const { logger, lines } = recordingLogger();
    const host = createExtractHost(
      { ...DEFAULT_EXTRACT_CONFIG, maxQueued: 1 },
      { logger, onStuck: vi.fn(), startThread: threads.startThread },
    );
    void host.extract(request());
    void host.extract(request());
    expect(await host.extract(request())).toEqual({ ok: false, error: 'code.queue_full' });
    expect(lines.at(-1)).toMatchObject({ event: 'code_intel.extract_refused', level: 'warn' });
  });

  it('refuses a file over the byte limit before it queues', async () => {
    const { logger } = recordingLogger();
    const startThread = vi.fn();
    const host = createExtractHost(
      { ...DEFAULT_EXTRACT_CONFIG, maxSourceBytes: 4 },
      { logger, onStuck: vi.fn(), startThread },
    );
    // Five bytes in UTF-8 though four characters long.
    expect(await host.extract(request('abcé'))).toEqual({ ok: false, error: 'code.too_large' });
    expect(startThread).not.toHaveBeenCalled();
  });

  it('starts a new thread after a kill', async () => {
    const threads = heldThreads();
    const { logger } = recordingLogger();
    const host = createExtractHost(DEFAULT_EXTRACT_CONFIG, {
      logger,
      onStuck: vi.fn(),
      startThread: threads.startThread,
    });
    const slow = host.extract(request());
    await flush();
    threads.held[0]?.({ answer: { ok: false, error: 'code.timeout' }, end: 'killed', workMs: 9 });
    expect(await slow).toEqual({ ok: false, error: 'code.timeout' });
    const next = host.extract(request());
    await flush();
    threads.held[1]?.(done);
    expect(await next).toEqual(done.answer);
    expect(threads.started()).toBe(2);
  });

  it('retires a thread after its share of files', async () => {
    const threads = heldThreads();
    const { logger } = recordingLogger();
    const host = createExtractHost(
      { ...DEFAULT_EXTRACT_CONFIG, recycleAfter: 2 },
      { logger, onStuck: vi.fn(), startThread: threads.startThread },
    );
    for (let index = 0; index < 3; index += 1) {
      const answer = host.extract(request());
      await flush();
      threads.held[index]?.(done);
      await answer;
    }
    expect(threads.started()).toBe(2);
    expect(threads.stopped).toEqual([1]);
  });

  it('gives up the process when a thread cannot be ended', async () => {
    const threads = heldThreads();
    const { logger } = recordingLogger();
    const onStuck = vi.fn();
    const host = createExtractHost(DEFAULT_EXTRACT_CONFIG, {
      logger,
      onStuck,
      startThread: threads.startThread,
    });
    const stuck = host.extract(request());
    const behind = host.extract(request());
    await flush();
    threads.held[0]?.({ answer: { ok: false, error: 'code.timeout' }, end: 'stuck', workMs: 9 });
    expect(await stuck).toEqual({ ok: false, error: 'code.timeout' });
    expect(await behind).toEqual({ ok: false, error: 'code.unavailable' });
    expect(onStuck).toHaveBeenCalledOnce();
    expect(await host.extract(request())).toEqual({ ok: false, error: 'code.closed' });
  });

  it('refuses what waits when it closes', async () => {
    const threads = heldThreads();
    const { logger } = recordingLogger();
    const host = createExtractHost(DEFAULT_EXTRACT_CONFIG, {
      logger,
      onStuck: vi.fn(),
      startThread: threads.startThread,
    });
    const running = host.extract(request());
    const waiting = host.extract(request());
    await flush();
    const closing = host.close();
    expect(await waiting).toEqual({ ok: false, error: 'code.closed' });
    threads.held[0]?.(done);
    expect(await running).toEqual(done.answer);
    await closing;
    expect(threads.stopped).toEqual([1]);
  });

  it('rejects a malformed request, which is a caller bug', () => {
    const { logger } = recordingLogger();
    const host = createExtractHost(DEFAULT_EXTRACT_CONFIG, { logger, onStuck: vi.fn() });
    expect(() =>
      host.extract({ ...request(), tenant: { organizationId: 'x', projectId: 'y' } } as never),
    ).toThrow();
    expect(() => host.extract({ ...request(), language: 'cobol' } as never)).toThrow();
  });

  it('rejects a config that bounds nothing', () => {
    const { logger } = recordingLogger();
    expect(() =>
      createExtractHost({ ...DEFAULT_EXTRACT_CONFIG, maxQueued: 0 }, { logger, onStuck: vi.fn() }),
    ).toThrow();
  });

  it('logs tenant, path and counts, never the file', async () => {
    const threads = heldThreads();
    const { logger, lines } = recordingLogger();
    const host = createExtractHost(DEFAULT_EXTRACT_CONFIG, {
      logger,
      onStuck: vi.fn(),
      startThread: threads.startThread,
    });
    const secret = 'export const TOKEN = "sk_live_do_not_log";';
    const answer = host.extract(request(secret));
    await flush();
    threads.held[0]?.(done);
    await answer;
    expect(lines).toEqual([
      {
        level: 'info',
        event: 'code_intel.extracted',
        fields: {
          organizationId: TENANT.organizationId,
          projectId: TENANT.projectId,
          path: 'src/a.ts',
          language: 'typescript',
          bytes: secret.length,
          symbols: 0,
          routes: 0,
          partial: false,
          workMs: 1,
        },
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain('sk_live');
  });
});

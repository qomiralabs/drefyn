import { afterEach, describe, expect, it } from 'vitest';
import { startExtractThread } from '../src/thread.ts';
import type { ExtractThread, ThreadLimits } from '../src/thread.ts';
import { fixture } from './helpers.ts';

const TIMEOUT_MS = 60_000;
const LIMITS: ThreadLimits = {
  timeoutMs: 5_000,
  maxMemoryMb: 64,
  killGraceMs: 2_000,
  startTimeoutMs: 10_000,
};
const standIn = new URL('./hosts/worker-stand-in.ts', import.meta.url);
const job = { language: 'typescript' as const, source: 'export const a = 1;', path: 'a.ts' };

const threads: ExtractThread[] = [];
afterEach(async () => {
  await Promise.all(threads.splice(0).map((thread) => thread.stop()));
});

function start(mode: string, limits: ThreadLimits = LIMITS): ExtractThread {
  const thread = startExtractThread(limits, standIn, mode);
  threads.push(thread);
  return thread;
}

describe('an extract thread', () => {
  it(
    'extracts on the real worker and stays reusable',
    async () => {
      const thread = startExtractThread(LIMITS);
      threads.push(thread);
      const first = await thread.run({ ...job, source: fixture('go/client.go'), language: 'go' });
      expect(first.end).toBe('reusable');
      expect(first.answer.ok && first.answer.value.symbols.length).toBe(14);
      expect((await thread.run(job)).answer.ok).toBe(true);
    },
    TIMEOUT_MS,
  );

  it.each([
    ['answers in the wrong shape', 'wrong-shape', 'code.failed'],
    ['answers for another file', 'wrong-id', 'code.failed'],
    ['throws', 'crash', 'code.failed'],
    ['exits', 'exit', 'code.failed'],
    ['runs out of memory', 'oom', 'code.out_of_memory'],
  ])(
    'is killed when it %s',
    async (_case, mode, code) => {
      const run = await start(mode).run(job);
      expect(run.answer).toEqual({ ok: false, error: code });
      expect(run.end).toBe('killed');
    },
    TIMEOUT_MS,
  );

  it(
    'is given up when it never says it is ready',
    async () => {
      const run = await start('never-ready', { ...LIMITS, startTimeoutMs: 200 }).run(job);
      expect(run).toEqual({
        answer: { ok: false, error: 'code.unavailable' },
        end: 'killed',
        workMs: 0,
      });
    },
    TIMEOUT_MS,
  );
});

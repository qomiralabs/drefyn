import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../src/index.ts';
import { DEFAULT_PRINT_TIMEOUT_MS } from '../src/pool-config.ts';
import { startParseThread } from '../src/thread.ts';
import { maxTreeBytes } from '../src/wire.ts';
import { honestPage } from './honest-page.ts';
import { isolatedPolicy, parsed, policy } from './helpers.ts';
import { allNew } from './print-helpers.ts';
import { parseForStore } from '../src/parse.ts';

const WORKER = new URL('../src/parse-worker.ts', import.meta.url);
const SLOW_MS = 120_000;
const KILL_AT_MS = 1_500;

// Passes every parser limit and parses in milliseconds. The stock printer retries a render per
// mistake on adjacent emphasis, which took 10.9 s at 9 KB and has no limit of its own.
const ADJACENT_EMPHASIS = `${'*a*_b_'.repeat(3_000)}\n`;

const limits = { timeoutMs: KILL_AT_MS, maxMemoryMb: 256, killGraceMs: 2_000 };

// Time on the thread and not the clock: the kill asks how much work a page is, and on a busy
// machine a clock measures the machine. The wall clock figure comes from a real host, in the PR.
const METERED = new URL('./fixtures/workers/metered-print.ts', import.meta.url);

describe('an honest page at the size limit', () => {
  const printOn = async (tree: string) => {
    const thread = startParseThread(METERED, {
      timeoutMs: SLOW_MS,
      maxMemoryMb: 512,
      killGraceMs: 2_000,
    });
    const { result } = await thread.run({ tree, policy: isolatedPolicy() });
    await thread.stop();
    return result as unknown as { ok: boolean; value: { cpuMs: number; printed: boolean } };
  };

  it.each(['mdx', 'md'] as const)(
    'fits inside the print limit as all new blocks in %s',
    async (dialect) => {
      const page = honestPage(dialect);
      expect(Buffer.byteLength(page)).toBe(DEFAULT_LIMITS.maxBytes);
      const tree = JSON.stringify(allNew(parsed(page, dialect)));
      const { ok, value } = await printOn(tree);
      expect(ok).toBe(true);
      expect(value.printed).toBe(true);
      expect(value.cpuMs).toBeLessThan(DEFAULT_PRINT_TIMEOUT_MS);
    },
    SLOW_MS,
  );

  it(
    'fits a tree inside the cap of the wire, with room to spare',
    () => {
      for (const dialect of ['mdx', 'md'] as const) {
        const tree = JSON.stringify(parsed(honestPage(dialect), dialect));
        expect(Buffer.byteLength(tree) * 2).toBeLessThan(maxTreeBytes(DEFAULT_LIMITS.maxBytes));
      }
    },
    SLOW_MS,
  );
});

describe('printing under the kill', () => {
  it(
    'runs to the print limit, past the limit a parse gets',
    async () => {
      const thread = startParseThread(WORKER, {
        ...limits,
        timeoutMs: 100,
        printTimeoutMs: KILL_AT_MS,
      });
      const tree = JSON.stringify(allNew(parsed(ADJACENT_EMPHASIS, 'md')));
      const answer = await thread.run({ tree, policy: isolatedPolicy() });
      expect(answer.result).toMatchObject({ error: [{ code: 'mdx.parse_timeout' }] });
      expect(answer.workMs).toBeGreaterThanOrEqual(KILL_AT_MS);
      await thread.stop();
    },
    SLOW_MS,
  );

  it(
    'leaves a parse to its own shorter limit',
    async () => {
      const thread = startParseThread(
        new URL('./fixtures/workers/stall-regex.ts', import.meta.url),
        {
          ...limits,
          timeoutMs: 200,
          printTimeoutMs: 60_000,
        },
      );
      const answer = await thread.run({ source: 'a', dialect: 'md', policy: isolatedPolicy() });
      expect(answer.result).toMatchObject({ error: [{ code: 'mdx.parse_timeout' }] });
      expect(answer.workMs).toBeLessThan(30_000);
      await thread.stop();
    },
    SLOW_MS,
  );

  it(
    'ends a page that would hold the printer for far longer than the limit',
    async () => {
      expect(parseForStore(ADJACENT_EMPHASIS, 'md', policy()).ok).toBe(true);
      const thread = startParseThread(WORKER, limits);
      const tree = JSON.stringify(allNew(parsed(ADJACENT_EMPHASIS, 'md')));
      const answer = await thread.run({ tree, policy: isolatedPolicy() });
      expect(answer.end).toBe('killed');
      expect(answer.result).toMatchObject({
        ok: false,
        error: [{ code: 'mdx.parse_timeout' }],
      });
      expect(answer.workMs).toBeGreaterThanOrEqual(KILL_AT_MS);
      expect(thread.alive()).toBe(false);
      await thread.stop();
    },
    SLOW_MS,
  );

  it(
    'leaves an ordinary page to finish in the same thread',
    async () => {
      const thread = startParseThread(WORKER, { ...limits, timeoutMs: 60_000 });
      const tree = JSON.stringify(allNew(parsed('# a\n\n*b* c\n', 'md')));
      const answer = await thread.run({ tree, policy: isolatedPolicy() });
      expect(answer.end).toBe('reusable');
      expect(answer.result).toMatchObject({ ok: true, value: { text: '# a\n\n*b* c\n' } });
      await thread.stop();
    },
    SLOW_MS,
  );

  it(
    'answers a parse from the same worker as before',
    async () => {
      const thread = startParseThread(WORKER, { ...limits, timeoutMs: 60_000 });
      const answer = await thread.run({
        source: 'a\n',
        dialect: 'md',
        policy: isolatedPolicy(),
      });
      expect(answer.result).toMatchObject({ ok: true, value: { issues: [] } });
      await thread.stop();
    },
    SLOW_MS,
  );
});

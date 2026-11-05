import { describe, expect, it } from 'vitest';
import { startParseThread } from '../src/thread.ts';
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

describe('printing under the kill', () => {
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

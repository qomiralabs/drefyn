import { describe, expect, it } from 'vitest';
import { serialize } from '../src/index.ts';
import { parseIsolated, runIsolated } from '../src/isolated.ts';
import { policy } from './helpers.ts';

const LIMITS = { timeoutMs: 20_000, maxMemoryMb: 256 };
const SHORT = { timeoutMs: 500, maxMemoryMb: 256 };
// Workers start slowly on a loaded runner, so the proof is that the promise settles at all.
const TIMEOUT_MS = 60_000;
const worker = (name: string) => new URL(`./fixtures/workers/${name}.ts`, import.meta.url);
const isolatedPolicy = { ...policy(), components: new Set(['Note']) };

describe('parseIsolated', () => {
  it(
    'gives the same answer as the direct parse',
    async () => {
      const source = '# One\n\n<Note a="1" />\n';
      const result = await parseIsolated(source, 'mdx', isolatedPolicy, LIMITS);
      if (!result.ok) throw new Error('refused');
      expect(result.value.issues).toEqual([]);
      expect(serialize(result.value.ast)).toBe(source);
    },
    TIMEOUT_MS,
  );

  it(
    'passes a refusal through',
    async () => {
      const result = await parseIsolated('<Open>\n', 'mdx', isolatedPolicy, LIMITS);
      expect(result).toMatchObject({ ok: false, error: [{ code: 'mdx.parse_failed', line: 1 }] });
    },
    TIMEOUT_MS,
  );

  it.each([
    ['a zero timeout', { timeoutMs: 0, maxMemoryMb: 256 }],
    ['an unbounded timeout', { timeoutMs: Number.POSITIVE_INFINITY, maxMemoryMb: 256 }],
    ['a tiny heap', { timeoutMs: 1_000, maxMemoryMb: 1 }],
    ['an unbounded heap', { timeoutMs: 1_000, maxMemoryMb: 1_000_000 }],
  ])('rejects %s, which is our bug and not bad content', async (_name, limits) => {
    await expect(parseIsolated('a', 'md', isolatedPolicy, limits)).rejects.toThrow();
  });
});

describe('the kill path', () => {
  it(
    'ends a stall inside a regular expression',
    async () => {
      await expect(runIsolated(worker('stall-regex'), null, SHORT)).resolves.toEqual({
        ok: false,
        error: [{ code: 'mdx.parse_timeout', severity: 'error', line: 1, column: 1 }],
      });
    },
    TIMEOUT_MS,
  );

  it(
    'ends a thread that runs out of its heap, and the process lives',
    async () => {
      const limits = { timeoutMs: 45_000, maxMemoryMb: 32 };
      await expect(runIsolated(worker('allocate'), null, limits)).resolves.toEqual({
        ok: false,
        error: [{ code: 'mdx.out_of_memory', severity: 'error', line: 1, column: 1 }],
      });
    },
    TIMEOUT_MS,
  );

  it(
    'turns a crash into a refusal with no message in it',
    async () => {
      const result = await runIsolated(worker('crash'), null, LIMITS);
      expect(result).toEqual({
        ok: false,
        error: [{ code: 'mdx.parse_failed', severity: 'error', line: 1, column: 1 }],
      });
    },
    TIMEOUT_MS,
  );
});

import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { serialize } from '../src/index.ts';
import type { Dialect, MdxIssueCode } from '../src/index.ts';
import { createParsePool } from '../src/isolated.ts';
import { isolatedPolicy, ORG_A, POOL_CONFIG, projectAt, recordingLogger } from './helpers.ts';

const BYTES = 200_000;
const LIMITS = { ...POOL_CONFIG, timeoutMs: 3_000 };
// The bound under test is the timeout. The grace covers a loaded runner starting and stopping
// a thread, and is still far below the minutes these inputs take with no kill.
const GRACE_MS = 15_000;
const RUNS = 12;

const STOPPED: readonly MdxIssueCode[] = [
  'mdx.parse_failed',
  'mdx.parse_timeout',
  'mdx.out_of_memory',
  'mdx.too_deep',
  'mdx.too_many_nodes',
];

const MARKS = Array.from('a.-+_*~<>!?[](){}`\\&:/@|=#"\' \n');

// Short units repeated to size, broken by blank lines or not, so a generated page aims at
// what makes the parser quadratic without naming any one construct.
const unit = fc.string({
  unit: fc.constantFrom(...MARKS),
  minLength: 1,
  maxLength: 4,
});

const page = fc.record({ start: unit, repeated: unit, gap: fc.constantFrom('', '\n\n', '\n') });

describe('generated hostile pages', () => {
  const pool = createParsePool(LIMITS, { logger: recordingLogger() });
  afterAll(() => pool.close());
  let run = 0;

  it(
    'always settle within the timeout',
    async () => {
      await fc.assert(
        fc.asyncProperty(page, fc.constantFrom<Dialect>('md', 'mdx'), async (shape, dialect) => {
          const { start, repeated, gap } = shape;
          const body = `${repeated.repeat(Math.ceil(2_000 / repeated.length))}${gap}`;
          const source = start + body.repeat(Math.ceil(BYTES / body.length));
          const began = performance.now();
          const result = await pool.parse({
            organizationId: ORG_A,
            projectId: projectAt(run++),
            path: 'docs/generated.mdx',
            source,
            dialect,
            policy: isolatedPolicy(),
          });
          expect(performance.now() - began).toBeLessThan(LIMITS.timeoutMs + GRACE_MS);
          if (result.ok) expect(serialize(result.value.ast)).toBe(source);
          else expect(STOPPED).toContain(result.error[0]?.code);
        }),
        { numRuns: RUNS },
      );
    },
    (LIMITS.timeoutMs + GRACE_MS) * RUNS,
  );
});

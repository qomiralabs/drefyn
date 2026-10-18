// Not a gate: the check does no I/O, so this only shows that validating a full
// override map on every call costs far less than anything a request would notice.
import { test } from 'vitest';
import { LIMIT_KEYS, UNLIMITED, checkLimit } from '../src/index.ts';
import type { LimitOverrides } from '../src/index.ts';

// UNLIMITED raises every key on every tier, so the whole map passes validation.
const full: LimitOverrides = Object.fromEntries(LIMIT_KEYS.map((key) => [key, UNLIMITED]));
const withMap = { overrides: full, graceEligible: true } as const;
// Bound once: the test runner wraps each import in a getter, which would be timed too.
const check = checkLimit;

test('checkLimit cost per call', async ({ bench }) => {
  await bench.compare(
    bench(`checkLimit with a ${String(LIMIT_KEYS.length)} key override map`, () => {
      check('enterprise', 'status.email_sends_per_month', 2001, withMap);
    }),
    bench('checkLimit without overrides', () => {
      check('enterprise', 'status.email_sends_per_month', 2001);
    }),
    { iterations: 1_000_000, time: 0, warmupIterations: 10_000 },
  );
});

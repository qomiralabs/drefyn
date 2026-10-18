// Not a gate: the check does no I/O, so this only shows that validating a full
// override map on every call costs far less than anything a request would notice.
// bench/native.ts gives the same cases without the test runner's import overhead.
import { test } from 'vitest';
import { LIMIT_KEYS, checkLimit } from '../src/index.ts';
import { finiteMap, unlimitedMap } from '../bench/maps.ts';

const withFinite = { overrides: finiteMap, graceEligible: true } as const;
const withUnlimited = { overrides: unlimitedMap, graceEligible: true } as const;
// Bound once: the test runner wraps each import in a getter, which would be timed too.
const check = checkLimit;
const size = String(LIMIT_KEYS.length);

test('checkLimit cost per call', async ({ bench }) => {
  await bench.compare(
    bench(`checkLimit with a ${size} key override map, finite cap`, () => {
      check('enterprise', 'status.email_sends_per_month', 2001, withFinite);
    }),
    bench(`checkLimit with a ${size} key override map, unlimited cap`, () => {
      check('enterprise', 'status.email_sends_per_month', 2001, withUnlimited);
    }),
    bench('checkLimit without overrides', () => {
      check('enterprise', 'status.email_sends_per_month', 2001);
    }),
    { iterations: 1_000_000, time: 0, warmupIterations: 10_000 },
  );
});

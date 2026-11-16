// Not a gate: the math does no I/O. Run with `pnpm --filter @drefyn/credits bench`; the
// medians go in the PR that changes this code.
import { test } from 'vitest';
import { creditsForUsage, estimateCredits, parseRateTable } from '../src/index.ts';
import { FIXTURE_TABLE, usage } from './rates.fixture.ts';

const table = parseRateTable(FIXTURE_TABLE);
// Bound once: the test runner wraps each import in a getter, which would be timed too.
const estimate = estimateCredits;
const charge = creditsForUsage;

// Three calls: a draft, its check and a long prompt on the premium model.
const planned = [
  { modelId: 'fixture-mid', maxPromptTokens: 24_000, maxOutputTokens: 4_000 },
  { modelId: 'fixture-small', maxPromptTokens: 8_000, maxOutputTokens: 1_000 },
  { modelId: 'fixture-large', maxPromptTokens: 120_000, maxOutputTokens: 8_000 },
];
const measured = [
  { modelId: 'fixture-mid', usage: usage(20_000, 2_000) },
  { modelId: 'fixture-small', usage: usage(6_000, 400) },
  { modelId: 'fixture-large', usage: usage(110_000, 6_000) },
];

test('credit math cost for 3 calls', async ({ bench }) => {
  await bench.compare(
    bench('estimateCredits, 3 calls', () => {
      estimate(table, planned);
    }),
    bench('creditsForUsage, 3 calls', () => {
      charge(table, measured);
    }),
    { iterations: 200_000, time: 0, warmupIterations: 10_000 },
  );
});

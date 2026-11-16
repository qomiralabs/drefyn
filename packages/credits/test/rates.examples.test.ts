import { describe, expect, it } from 'vitest';
import { credits, creditsForUsage, estimateMonthlyRuns, parseRateTable } from '../src/index.ts';
import { FIXTURE_TABLE, usage } from './rates.fixture.ts';

const table = parseRateTable(FIXTURE_TABLE);

// The worked example runs from the credits design, priced on the made up fixture rates rather
// than real ones. Each run is the main call plus, for a draft, its accuracy check on the
// check model, rounded once.
describe('worked examples', () => {
  // 6 + 3 + 0.12 + 0.04 = 9.16 credits.
  it('an update draft on the middle model with its check costs 9 credits', () => {
    expect(
      creditsForUsage(table, [
        { modelId: 'fixture-mid', usage: usage(20_000, 2_000) },
        { modelId: 'fixture-small', usage: usage(6_000, 400) },
      ]),
    ).toBe(9);
  });

  // 14 + 7 + 0.16 = 21.16 credits.
  it('the same draft on the premium model costs 21 credits', () => {
    expect(
      creditsForUsage(table, [
        { modelId: 'fixture-large', usage: usage(20_000, 2_000) },
        { modelId: 'fixture-small', usage: usage(6_000, 400) },
      ]),
    ).toBe(21);
  });

  // 0.4 + 0.2 + 0.16 = 0.76 credits.
  it('the same draft on the small model rounds to 1 credit', () => {
    expect(
      creditsForUsage(table, [
        { modelId: 'fixture-small', usage: usage(20_000, 2_000) },
        { modelId: 'fixture-small', usage: usage(6_000, 400) },
      ]),
    ).toBe(1);
  });

  // 1.8 + 0.75 = 2.55 credits, half up.
  it('an assistant answer on the middle model costs 3 credits', () => {
    expect(creditsForUsage(table, [{ modelId: 'fixture-mid', usage: usage(6_000, 500) }])).toBe(3);
  });

  it('the reference profiles give the same charges for "about N per month"', () => {
    expect(estimateMonthlyRuns(table, credits(1_000), 'stale_draft', 'fixture-mid')).toBe(111);
    expect(estimateMonthlyRuns(table, credits(1_000), 'stale_draft', 'fixture-large')).toBe(47);
    expect(estimateMonthlyRuns(table, credits(1_000), 'reader_answer', 'fixture-mid')).toBe(333);
  });
});

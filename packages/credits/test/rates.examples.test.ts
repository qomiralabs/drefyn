import { describe, expect, it } from 'vitest';
import { credits, creditsForUsage, estimateMonthlyRuns, parseRateTable } from '../src/index.ts';
import { FIXTURE_TABLE, usage } from './rates.fixture.ts';

const table = parseRateTable(FIXTURE_TABLE);

// The worked examples from the credits design, on the fixture rates. Each run is the main
// call plus, for a draft, its accuracy check on the check model, rounded once.
describe('worked examples', () => {
  it('an update draft on the middle model with its check costs 10 credits', () => {
    expect(
      creditsForUsage(table, [
        { modelId: 'fixture-mid', usage: usage(20_000, 2_000) },
        { modelId: 'fixture-small', usage: usage(6_000, 400) },
      ]),
    ).toBe(10);
  });

  it('the same draft on the premium model costs 20 credits', () => {
    expect(
      creditsForUsage(table, [
        { modelId: 'fixture-large', usage: usage(20_000, 2_000) },
        { modelId: 'fixture-small', usage: usage(6_000, 400) },
      ]),
    ).toBe(20);
  });

  it('the same draft on the small model costs the 1 credit minimum', () => {
    expect(
      creditsForUsage(table, [
        { modelId: 'fixture-small', usage: usage(20_000, 2_000) },
        { modelId: 'fixture-small', usage: usage(6_000, 400) },
      ]),
    ).toBe(1);
  });

  it('an assistant answer on the middle model costs 3 credits', () => {
    expect(creditsForUsage(table, [{ modelId: 'fixture-mid', usage: usage(6_000, 500) }])).toBe(3);
  });

  it('the reference profiles give the same charges for "about N per month"', () => {
    expect(estimateMonthlyRuns(table, credits(1_000), 'stale_draft', 'fixture-mid')).toBe(100);
    expect(estimateMonthlyRuns(table, credits(1_000), 'stale_draft', 'fixture-large')).toBe(50);
    expect(estimateMonthlyRuns(table, credits(1_000), 'reader_answer', 'fixture-mid')).toBe(333);
  });
});

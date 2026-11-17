import { closeDatabase, type Database, type PublishedDatabase } from '@drefyn/db';
import fc from 'fast-check';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { B, K1 } from '../src/bm25.ts';
import { DEFAULT_RETRIEVAL_CONFIG, type Retrieval } from '../src/index.ts';
import {
  bodies,
  chunkIdOf,
  openApp,
  openReader,
  retrievalOver,
  seedPages,
  seedTenants,
  type Seeded,
  type SeededPage,
} from './support/fixture.ts';
import { describeWithStack } from './support/presence.ts';
import { idf, weight } from './support/reference.ts';
import { scoredSearch } from './support/search.ts';

// Four chunks, each its own page with no heading, so the indexed text is the body alone:
//   A "alpha beta beta"          length 3   alpha 1, beta 2
//   B "beta gamma"               length 2   beta 1, gamma 1
//   C "gamma delta delta delta"  length 4   gamma 1, delta 3
//   D "epsilon"                  length 1   epsilon 1
// N = 4, total length 10, average 2.5. df: alpha 1, beta 2, gamma 2, delta 1, epsilon 1.
//   idf(df) = ln(1 + (N - df + 0.5) / (df + 0.5))
//   idf(1) = ln(10 / 3) = 1.2039728043259361, idf(2) = ln 2 = 0.6931471805599453,
//   idf(0) = ln 10 = 2.302585092994046
//   term = idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * length / average)), k1 1.2, b 0.75
// "beta delta":
//   C: delta, tf 3, length 4: ln(10/3) * 6.6 / (3 + 1.2 * 1.45) = ln(10/3) * 6.6 / 4.74
//      = 1.6764178288082656
//   A: beta, tf 2, length 3:  ln 2 * 4.4 / (2 + 1.2 * 1.15) = ln 2 * 4.4 / 3.38
//      = 0.902321773509988
//   B: beta, tf 1, length 2:  ln 2 * 2.2 / (1 + 1.2 * 0.85) = ln 2 * 2.2 / 2.02
//      = 0.7549127709068711
const FIXTURE = ['alpha beta beta', 'beta gamma', 'gamma delta delta delta', 'epsilon'];
const HAND = { C: 1.6764178288082656, A: 0.902321773509988, B: 0.7549127709068711 };

it('uses the constants the gate was tuned on', () => {
  expect(K1).toBe(1.2);
  expect(B).toBe(0.75);
});

it('the written out formula gives the hand computed numbers', () => {
  expect(idf(4, 1)).toBeCloseTo(1.2039728043259361, 15);
  expect(idf(4, 2)).toBeCloseTo(0.6931471805599453, 15);
  expect(idf(4, 0)).toBeCloseTo(2.302585092994046, 15);
  expect(weight(3, 4, 2.5, idf(4, 1))).toBeCloseTo(HAND.C, 15);
  expect(weight(2, 3, 2.5, idf(4, 2))).toBeCloseTo(HAND.A, 15);
  expect(weight(1, 2, 2.5, idf(4, 2))).toBeCloseTo(HAND.B, 15);
});

describeWithStack('BM25 in the statement', () => {
  let app: Database;
  let reader: PublishedDatabase;
  let retrieval: Retrieval;
  let seeded: Seeded;
  let pages: SeededPage[];

  beforeAll(async () => {
    app = await openApp();
    reader = await openReader();
    retrieval = retrievalOver(reader);
    [seeded] = (await seedTenants([1])) as [Seeded];
    pages = await seedPages(app, seeded, bodies('bm25', FIXTURE));
  });

  afterAll(async () => {
    await closeDatabase(reader);
    await closeDatabase(app);
  });

  it('scores match the hand computed fixture, best first', async () => {
    const found = await scoredSearch(reader, seeded.tenant, 'beta delta', DEFAULT_RETRIEVAL_CONFIG);
    expect(found.hits.map((h) => h.chunkId)).toEqual([
      chunkIdOf(pages[2]),
      chunkIdOf(pages[0]),
      chunkIdOf(pages[1]),
    ]);
    const [c, a, b] = found.hits;
    expect(c?.score).toBeCloseTo(HAND.C, 12);
    expect(a?.score).toBeCloseTo(HAND.A, 12);
    expect(b?.score).toBeCloseTo(HAND.B, 12);
    expect(found.chunkCount).toBe(4);
  });

  it('retrieve returns the same order as ranks, with no scores', async () => {
    const result = await retrieval.retrieve(seeded.tenant, { query: 'beta delta' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hits.map((h) => [h.rank, h.chunkId])).toEqual([
      [1, chunkIdOf(pages[2])],
      [2, chunkIdOf(pages[0])],
      [3, chunkIdOf(pages[1])],
    ]);
    expect(JSON.stringify(result)).not.toContain('score');
  });

  it('a punctuation only query returns no hits and no error', async () => {
    for (const query of ['?!', '... -- ;;', '()[]{}', '¿¡ * &']) {
      const result = await retrieval.retrieve(seeded.tenant, { query });
      expect(result).toMatchObject({ ok: true, value: { hits: [] } });
    }
  });

  it('a question with operators in it is plain words, never syntax', async () => {
    for (const query of ["beta & !delta | 'x'", 'beta <-> delta', 'beta:* delta']) {
      const result = await retrieval.retrieve(seeded.tenant, { query });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.hits.length).toBeGreaterThan(0);
    }
  });

  it('a word no chunk holds matches nothing', async () => {
    const found = await scoredSearch(reader, seeded.tenant, 'zeta', DEFAULT_RETRIEVAL_CONFIG);
    expect(found.hits).toEqual([]);
  });

  it('scores are positive and come best first for any mix of the fixture words', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.constantFrom('alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'), {
          minLength: 1,
        }),
        async (words) => {
          const found = await scoredSearch(
            reader,
            seeded.tenant,
            words.join(' '),
            DEFAULT_RETRIEVAL_CONFIG,
          );
          const scores = found.hits.map((h) => h.score);
          expect(scores).toEqual([...scores].sort((x, y) => y - x));
          for (const score of scores) expect(score).toBeGreaterThan(0);
        },
      ),
      { numRuns: 15 },
    );
  });
});

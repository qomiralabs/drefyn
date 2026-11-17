import { closeDatabase, type Database, type PublishedDatabase } from '@drefyn/db';
import fc from 'fast-check';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Retrieval } from '../../src/index.ts';
import {
  bodies,
  openApp,
  openReader,
  retrievalOver,
  seedPages,
  seedTenants,
  type Seeded,
} from '../support/fixture.ts';
import { describeWithStack } from '../support/presence.ts';

// The BM25 fixture: N = 4, average length 2.5.
//   "beta delta zeta": the top hit is "gamma delta delta delta", which holds delta only.
//   coverage = idf(delta) / (idf(beta) + idf(delta) + idf(zeta))
//            = ln(10/3) / (ln 2 + ln(10/3) + ln 10)
//            = 1.2039728043259361 / 4.199705077879927 = 0.28668032207007244
//   "alpha beta": the top hit "alpha beta beta" holds both, so coverage is 1.
const FIXTURE = ['alpha beta beta', 'beta gamma', 'gamma delta delta delta', 'epsilon'];

describeWithStack('retrieveScored', () => {
  let app: Database;
  let reader: PublishedDatabase;
  let retrieval: Retrieval;
  let seeded: Seeded;

  beforeAll(async () => {
    app = await openApp();
    reader = await openReader();
    retrieval = retrievalOver(reader);
    [seeded] = (await seedTenants([1])) as [Seeded];
    await seedPages(app, seeded, bodies('scored', FIXTURE));
  });

  afterAll(async () => {
    await closeDatabase(reader);
    await closeDatabase(app);
  });

  it('coverage matches the hand computed fixture', async () => {
    const partly = await retrieval.retrieveScored(seeded.tenant, { query: 'beta delta zeta' });
    expect(partly.ok).toBe(true);
    if (partly.ok) expect(partly.value.coverage).toBeCloseTo(0.28668032207007244, 12);
    const fully = await retrieval.retrieveScored(seeded.tenant, { query: 'alpha beta' });
    expect(fully.ok).toBe(true);
    if (fully.ok) expect(fully.value.coverage).toBeCloseTo(1, 12);
    const none = await retrieval.retrieveScored(seeded.tenant, { query: 'zeta eta' });
    expect(none).toMatchObject({ ok: true, value: { coverage: 0, hits: [] } });
  });

  it('returns the same hits as retrieve for the same input', async () => {
    const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'the'];
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...words), { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 1, max: 20 }),
        async (query, limit) => {
          const input = { query: query.join(' '), limit };
          const plain = await retrieval.retrieve(seeded.tenant, input);
          const scored = await retrieval.retrieveScored(seeded.tenant, input);
          expect(plain.ok && scored.ok).toBe(true);
          if (!plain.ok || !scored.ok) return;
          const { coverage, ...rest } = scored.value;
          expect(rest).toEqual(plain.value);
          expect(coverage).toBeGreaterThanOrEqual(0);
          expect(coverage).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 25 },
    );
  });
});

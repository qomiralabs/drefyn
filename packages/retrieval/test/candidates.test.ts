import { closeDatabase, type Database, type PublishedDatabase } from '@drefyn/db';
import fc from 'fast-check';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DEFAULT_RETRIEVAL_CONFIG } from '../src/index.ts';
import {
  bodies,
  chunkIdOf,
  openApp,
  openReader,
  seedPages,
  seedTenants,
  type Seeded,
  type SeededPage,
} from './support/fixture.ts';
import { describeWithStack } from './support/presence.ts';
import {
  queryLexemes,
  recomputedCorpus,
  reference,
  type Caps,
  type Corpus,
} from './support/reference.ts';
import { scoredSearch } from './support/search.ts';

// Ten chunks. "common" is in five of them (50 percent) with term frequency 1 to 5, "rare" in
// one, and every chunk has a filler word of its own.
const CORPUS = [
  'common filler0',
  'common common filler1',
  'common common common filler2',
  'common common common common filler3',
  'common common common common common filler4',
  'filler5',
  'filler6',
  'filler7',
  'filler8',
  'rare filler9',
];

const OPEN: Caps = {
  maxQueryTerms: 32,
  commonTermPercent: 100,
  maxPostings: 1_000_000,
  maxScoredCandidates: 1_000_000,
};

describeWithStack('candidate caps against Postgres', () => {
  let app: Database;
  let reader: PublishedDatabase;
  let seeded: Seeded;
  let pages: SeededPage[];
  let corpus: Corpus;

  const chunk = (n: number) => chunkIdOf(pages[n]);

  // Runs the statement and the reference with the same caps; they must agree on hits,
  // scores, coverage and the work done.
  async function both(query: string, caps: Caps, limit = 20) {
    const found = await scoredSearch(reader, seeded.tenant, query, caps, { limit });
    const expected = reference(corpus, await queryLexemes(app, seeded.tenant, query), caps, limit);
    expect(found.hits.map((h) => h.chunkId)).toEqual(expected.hits.map((h) => h.chunkId));
    found.hits.forEach((hit, at) => {
      expect(hit.score).toBeCloseTo(expected.hits[at]?.score ?? Number.NaN, 9);
    });
    expect(found.coverage ?? 0).toBeCloseTo(expected.coverage, 9);
    expect(found.lexemes).toBe(expected.lexemes);
    expect(found.candidates).toBe(expected.candidates);
    expect(found.postings).toBe(expected.postingsRead);
    return found;
  }

  beforeAll(async () => {
    app = await openApp();
    reader = await openReader();
    [seeded] = (await seedTenants([1])) as [Seeded];
    pages = await seedPages(app, seeded, bodies('cap', CORPUS));
    corpus = await recomputedCorpus(app, seeded.tenant);
  });

  afterAll(async () => {
    await closeDatabase(reader);
    await closeDatabase(app);
  });

  it('a lexeme at the common percent picks candidates; over it, it only scores', async () => {
    const at = await both('common rare', { ...OPEN, commonTermPercent: 50 });
    expect(at.candidates).toBe(6);
    expect(new Set(at.hits.map((h) => h.chunkId))).toEqual(new Set([0, 1, 2, 3, 4, 9].map(chunk)));
    const under = await both('common rare', { ...OPEN, commonTermPercent: 51 });
    expect(under.candidates).toBe(6);
    const over = await both('common rare', { ...OPEN, commonTermPercent: 49 });
    expect(over.candidates).toBe(1);
    expect(over.hits.map((h) => h.chunkId)).toEqual([chunk(9)]);
  });

  it('a common lexeme still scores the candidates rarer ones picked', async () => {
    // filler0 to filler2 pick chunks 0 to 2; "common" is over 40 percent so it is probed.
    const found = await both('common filler0 filler1 filler2', { ...OPEN, commonTermPercent: 40 });
    expect(found.candidates).toBe(3);
    expect(found.postings).toBe(3);
    // Only a probe can have added "common" to chunk 2's score.
    const without = await both('filler0 filler1 filler2', { ...OPEN, commonTermPercent: 40 });
    const scoreOf = (hits: typeof found.hits) => hits.find((h) => h.chunkId === chunk(2))?.score;
    expect(scoreOf(found.hits)).toBeGreaterThan(scoreOf(without.hits) ?? Number.POSITIVE_INFINITY);
  });

  it('postings read stop at the cap, rarest lexeme first', async () => {
    // rare (df 1) then common (df 5): 6 postings in all.
    expect((await both('common rare', { ...OPEN, maxPostings: 6 })).postings).toBe(6);
    expect((await both('common rare', { ...OPEN, maxPostings: 7 })).postings).toBe(6);
    const over = await both('common rare', { ...OPEN, maxPostings: 5 });
    expect(over.postings).toBe(1);
    expect(over.hits.map((h) => h.chunkId)).toEqual([chunk(9)]);
  });

  it('a rarest lexeme over the postings cap is read highest term frequency first', async () => {
    const at = await both('common', { ...OPEN, maxPostings: 5 });
    expect(at.postings).toBe(5);
    const over = await both('common', { ...OPEN, maxPostings: 3 });
    expect(over.postings).toBe(3);
    expect(over.hits.map((h) => h.chunkId)).toEqual([4, 3, 2].map(chunk));
    const under = await both('common', { ...OPEN, maxPostings: 6 });
    expect(under.postings).toBe(5);
  });

  it('when no lexeme is rare enough, the rarest one picks alone', async () => {
    const found = await both('common rare', { ...OPEN, commonTermPercent: 1 });
    expect(found.candidates).toBe(1);
    expect(found.postings).toBe(1);
    expect(found.hits.map((h) => h.chunkId)).toEqual([chunk(9)]);
  });

  it('only the best partial scores get the full score', async () => {
    const caps = { ...OPEN, commonTermPercent: 40 };
    const query = 'common filler0 filler1 filler2';
    expect((await both(query, { ...caps, maxScoredCandidates: 3 })).candidates).toBe(3);
    expect((await both(query, { ...caps, maxScoredCandidates: 4 })).candidates).toBe(3);
    const over = await both(query, { ...caps, maxScoredCandidates: 2 });
    expect(over.candidates).toBe(2);
    // Shorter chunks score higher on a filler word alone, so chunk 2 is cut before the
    // probe could lift it.
    expect(new Set(over.hits.map((h) => h.chunkId))).toEqual(new Set([0, 1].map(chunk)));
  });

  it('keeps only the first query lexemes, in the order the question says them', async () => {
    expect((await both('rare common filler9', { ...OPEN, maxQueryTerms: 3 })).lexemes).toBe(3);
    expect((await both('rare common filler9', { ...OPEN, maxQueryTerms: 4 })).lexemes).toBe(3);
    const over = await both('rare common filler9', { ...OPEN, maxQueryTerms: 1 });
    expect(over.lexemes).toBe(1);
    expect(over.hits.map((h) => h.chunkId)).toEqual([chunk(9)]);
    const two = await both('filler9 common rare', { ...OPEN, maxQueryTerms: 2 });
    expect(two.lexemes).toBe(2);
  });

  it('the defaults agree with the reference on every fixture word', async () => {
    for (const query of ['common', 'rare', 'common rare filler3', 'filler5 filler6 nothing']) {
      await both(query, DEFAULT_RETRIEVAL_CONFIG);
    }
  });

  it('agrees with the reference for any corpus, question and caps', async () => {
    const words = ['ant', 'bee', 'cat', 'dog', 'eel', 'fox', 'gnu', 'hen'];
    // Earlier words are far more likely, so some lexemes are common and some rare.
    const word = fc
      .integer({ min: 0, max: 63 })
      .map((n) => words[Math.min(words.length - 1, Math.floor(Math.log2(n + 1)))] ?? 'ant');
    const text = fc.array(word, { minLength: 1, maxLength: 8 }).map((w) => w.join(' '));
    const caps = fc
      .record({
        maxQueryTerms: fc.integer({ min: 1, max: 6 }),
        commonTermPercent: fc.integer({ min: 1, max: 100 }),
        maxPostings: fc.integer({ min: 1, max: 30 }),
        scoredShare: fc.integer({ min: 1, max: 100 }),
      })
      .map(({ scoredShare, ...rest }) => ({
        ...rest,
        maxScoredCandidates: Math.max(1, Math.floor((rest.maxPostings * scoredShare) / 100)),
      }));
    const question = fc
      .array(fc.oneof(word, fc.constant('yak')), { minLength: 1, maxLength: 6 })
      .map((w) => w.join(' '));
    await fc.assert(
      fc.asyncProperty(
        fc.array(text, { minLength: 1, maxLength: 12 }),
        fc.array(fc.tuple(question, caps, fc.integer({ min: 1, max: 20 })), {
          minLength: 1,
          maxLength: 4,
        }),
        async (texts, asks) => {
          [seeded] = (await seedTenants([1])) as [Seeded];
          pages = await seedPages(app, seeded, bodies('prop', texts));
          corpus = await recomputedCorpus(app, seeded.tenant);
          for (const [query, cap, limit] of asks) await both(query, cap, limit);
        },
      ),
      { numRuns: 20 },
    );
  });
});

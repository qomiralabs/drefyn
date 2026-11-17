import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRIEVAL_CONFIG,
  parseRetrievalConfig,
  RetrievalConfigError,
} from '../src/index.ts';

const refusal = (env: Record<string, string>) => {
  try {
    parseRetrievalConfig(env);
  } catch (error) {
    return error;
  }
  return null;
};

const refusedKey = (env: Record<string, string>) => {
  const error = refusal(env);
  expect(error).toBeInstanceOf(RetrievalConfigError);
  const refused = error as RetrievalConfigError;
  expect(refused.code).toBe('config.invalid');
  expect(refused.message).toContain(refused.key);
  return refused.key;
};

describe('parseRetrievalConfig', () => {
  it('uses the measured defaults when nothing is set', () => {
    const config = parseRetrievalConfig({});
    expect(config).toEqual(DEFAULT_RETRIEVAL_CONFIG);
    expect(config.maxQueryTerms).toBe(32);
    expect(config.commonTermPercent).toBe(50);
    expect(config.maxPostings).toBe(20000);
    expect(config.maxScoredCandidates).toBe(1000);
    expect(config.searchEngineMinChunks).toBe(25000);
    expect(config.timeoutMs).toBe(1500);
    expect(config.maxInFlight).toBe(8);
  });

  it('reads every key', () => {
    expect(
      parseRetrievalConfig({
        DREFYN_RETRIEVAL_MAX_QUERY_TERMS: '16',
        DREFYN_RETRIEVAL_COMMON_TERM_PERCENT: '100',
        DREFYN_RETRIEVAL_MAX_POSTINGS: '5000',
        DREFYN_RETRIEVAL_MAX_SCORED_CANDIDATES: '5000',
        DREFYN_RETRIEVAL_SEARCH_ENGINE_MIN_CHUNKS: '0',
        DREFYN_RETRIEVAL_TIMEOUT_MS: '900',
        DREFYN_RETRIEVAL_MAX_IN_FLIGHT: '2',
      }),
    ).toEqual({
      maxQueryTerms: 16,
      commonTermPercent: 100,
      maxPostings: 5000,
      maxScoredCandidates: 5000,
      searchEngineMinChunks: 0,
      timeoutMs: 900,
      maxInFlight: 2,
    });
  });

  it.each([
    ['DREFYN_RETRIEVAL_MAX_QUERY_TERMS', ['0', '-1', '1.5', 'x', '', ' 4', '2147483648']],
    ['DREFYN_RETRIEVAL_COMMON_TERM_PERCENT', ['0', '101', '-5', '50%', '']],
    ['DREFYN_RETRIEVAL_MAX_POSTINGS', ['0', '-1', '1e4', '', '2147483648']],
    ['DREFYN_RETRIEVAL_MAX_SCORED_CANDIDATES', ['0', '-1', '20001', 'many', '']],
    ['DREFYN_RETRIEVAL_SEARCH_ENGINE_MIN_CHUNKS', ['-1', '1.0', 'never', '', '2147483648']],
    ['DREFYN_RETRIEVAL_TIMEOUT_MS', ['0', '10001', 'fast', '']],
    ['DREFYN_RETRIEVAL_MAX_IN_FLIGHT', ['0', '1001', 'x', '']],
  ])('refuses a bad %s at boot and names it', (key, values) => {
    for (const value of values) expect(refusedKey({ [key]: value })).toBe(key);
  });

  it('refuses a full score bound above the postings cap, naming the bound', () => {
    expect(
      refusedKey({
        DREFYN_RETRIEVAL_MAX_POSTINGS: '500',
        DREFYN_RETRIEVAL_MAX_SCORED_CANDIDATES: '501',
      }),
    ).toBe('DREFYN_RETRIEVAL_MAX_SCORED_CANDIDATES');
    expect(
      parseRetrievalConfig({
        DREFYN_RETRIEVAL_MAX_POSTINGS: '500',
        DREFYN_RETRIEVAL_MAX_SCORED_CANDIDATES: '500',
      }).maxScoredCandidates,
    ).toBe(500);
  });

  it('never puts the refused value in the message', () => {
    const error = refusal({ DREFYN_RETRIEVAL_MAX_POSTINGS: 'secret-looking-value' });
    expect(error).toBeInstanceOf(RetrievalConfigError);
    expect((error as Error).message).not.toContain('secret-looking-value');
  });

  it('accepts any in range whole numbers', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (terms, percent, postings, engine) => {
          const scored = Math.max(1, Math.floor(postings / 2));
          const config = parseRetrievalConfig({
            DREFYN_RETRIEVAL_MAX_QUERY_TERMS: String(terms),
            DREFYN_RETRIEVAL_COMMON_TERM_PERCENT: String(percent),
            DREFYN_RETRIEVAL_MAX_POSTINGS: String(postings),
            DREFYN_RETRIEVAL_MAX_SCORED_CANDIDATES: String(scored),
            DREFYN_RETRIEVAL_SEARCH_ENGINE_MIN_CHUNKS: String(engine),
          });
          expect(config).toMatchObject({
            maxQueryTerms: terms,
            commonTermPercent: percent,
            maxPostings: postings,
            maxScoredCandidates: scored,
            searchEngineMinChunks: engine,
          });
        },
      ),
    );
  });

  it('gives back a frozen config', () => {
    expect(Object.isFrozen(parseRetrievalConfig({}))).toBe(true);
    expect(Object.isFrozen(DEFAULT_RETRIEVAL_CONFIG)).toBe(true);
  });
});

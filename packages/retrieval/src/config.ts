export interface RetrievalConfig {
  // Distinct question lexemes kept, in the order the question says them.
  readonly maxQueryTerms: number;
  // A lexeme in more than this percent of chunks scores but never picks candidates.
  readonly commonTermPercent: number;
  // Postings read to build candidates, whatever the project size.
  readonly maxPostings: number;
  // Candidates, best partial score first, that get every lexeme's term.
  readonly maxScoredCandidates: number;
  // Projects above this many public current chunks are reported for the search engine path.
  // 0 means never.
  readonly searchEngineMinChunks: number;
  readonly timeoutMs: number;
  // Retrievals at once per organization in this process.
  readonly maxInFlight: number;
}

export type RetrievalConfigKey =
  | 'DREFYN_RETRIEVAL_MAX_QUERY_TERMS'
  | 'DREFYN_RETRIEVAL_COMMON_TERM_PERCENT'
  | 'DREFYN_RETRIEVAL_MAX_POSTINGS'
  | 'DREFYN_RETRIEVAL_MAX_SCORED_CANDIDATES'
  | 'DREFYN_RETRIEVAL_SEARCH_ENGINE_MIN_CHUNKS'
  | 'DREFYN_RETRIEVAL_TIMEOUT_MS'
  | 'DREFYN_RETRIEVAL_MAX_IN_FLIGHT';

// Measured on the pinned 2 CPU, 1 GB image. A change to any of the first five moves recall or
// the gate's coverage, so it reruns the recall eval and the bench.
export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = Object.freeze({
  maxQueryTerms: 32,
  commonTermPercent: 50,
  maxPostings: 20000,
  maxScoredCandidates: 1000,
  searchEngineMinChunks: 25000,
  timeoutMs: 1500,
  maxInFlight: 8,
});

export class RetrievalConfigError extends Error {
  readonly code = 'config.invalid';
  readonly key: RetrievalConfigKey;

  constructor(key: RetrievalConfigKey, rule: string) {
    // The value is left out: a misplaced secret in the wrong variable would end up in a log.
    super(`${key} ${rule}`);
    this.name = 'RetrievalConfigError';
    this.key = key;
  }
}

// Every cap is sent to Postgres as an integer parameter.
const INT_MAX = 2_147_483_647;
// The public reader refuses a longer statement timeout.
const TIMEOUT_MAX_MS = 10_000;

function whole(
  env: Readonly<Record<string, string | undefined>>,
  key: RetrievalConfigKey,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const value = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RetrievalConfigError(
      key,
      `must be a whole number from ${String(min)} to ${String(max)}`,
    );
  }
  return value;
}

// Read once at boot, so a bad value stops the process before it serves a read.
export function parseRetrievalConfig(
  env: Readonly<Record<string, string | undefined>>,
): RetrievalConfig {
  const d = DEFAULT_RETRIEVAL_CONFIG;
  const maxPostings = whole(env, 'DREFYN_RETRIEVAL_MAX_POSTINGS', d.maxPostings, 1, INT_MAX);
  const config: RetrievalConfig = {
    maxQueryTerms: whole(env, 'DREFYN_RETRIEVAL_MAX_QUERY_TERMS', d.maxQueryTerms, 1, INT_MAX),
    commonTermPercent: whole(
      env,
      'DREFYN_RETRIEVAL_COMMON_TERM_PERCENT',
      d.commonTermPercent,
      1,
      100,
    ),
    maxPostings,
    maxScoredCandidates: whole(
      env,
      'DREFYN_RETRIEVAL_MAX_SCORED_CANDIDATES',
      d.maxScoredCandidates,
      1,
      INT_MAX,
    ),
    searchEngineMinChunks: whole(
      env,
      'DREFYN_RETRIEVAL_SEARCH_ENGINE_MIN_CHUNKS',
      d.searchEngineMinChunks,
      0,
      INT_MAX,
    ),
    timeoutMs: whole(env, 'DREFYN_RETRIEVAL_TIMEOUT_MS', d.timeoutMs, 1, TIMEOUT_MAX_MS),
    maxInFlight: whole(env, 'DREFYN_RETRIEVAL_MAX_IN_FLIGHT', d.maxInFlight, 1, 1000),
  };
  // Only the best candidates get the full score, so the bound can never exceed what was read.
  if (config.maxScoredCandidates > config.maxPostings) {
    throw new RetrievalConfigError(
      'DREFYN_RETRIEVAL_MAX_SCORED_CANDIDATES',
      'must be at most DREFYN_RETRIEVAL_MAX_POSTINGS',
    );
  }
  return Object.freeze(config);
}

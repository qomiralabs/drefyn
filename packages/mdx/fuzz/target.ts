import fc from 'fast-check';
import { DEFAULT_LIMITS, serialize } from '../src/index.ts';
import type { RenderPolicy } from '../src/index.ts';
import { parseForStore } from '../src/parse.ts';
import { dialectArbitrary, documentArbitrary } from './documents.ts';

const POLICY: RenderPolicy = {
  version: 1,
  components: new Set(['Note']),
  rawHtml: 'sanitize',
  remoteImages: 'proxy',
  linkProtocols: ['https', 'http', 'mailto'],
  limits: DEFAULT_LIMITS,
};

export interface FuzzOptions {
  readonly seconds: number;
  readonly seed: number;
  // A stricter check on top of the round trip; the test uses it to prove failures are seen.
  readonly check?: (source: string) => boolean;
}

export interface FuzzReport {
  readonly runs: number;
  readonly failure: string | undefined;
}

// Throwing, or printing anything other than the input, is a failure. A refusal is fine as
// long as it comes back as a Result.
export function fuzz({ seconds, seed, check }: FuzzOptions): FuzzReport {
  const property = fc.property(documentArbitrary, dialectArbitrary, (source, dialect) => {
    const result = parseForStore(source, dialect, POLICY);
    if (result.ok && serialize(result.value.ast) !== source) return false;
    return check === undefined || check(source);
  });
  const details = fc.check(property, {
    seed,
    numRuns: Number.MAX_SAFE_INTEGER,
    interruptAfterTimeLimit: seconds * 1_000,
    markInterruptAsFailure: false,
    endOnFailure: true,
  });
  const failure = details.failed
    ? `seed ${details.seed}, path ${details.counterexamplePath ?? 'unknown'}, input ${JSON.stringify(details.counterexample)}`
    : undefined;
  return { runs: details.numRuns, failure };
}

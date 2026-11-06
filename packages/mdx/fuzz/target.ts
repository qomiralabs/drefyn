import fc from 'fast-check';
import { DEFAULT_LIMITS } from '../src/index.ts';
import { serialize } from '../src/serialize.ts';
import type { MdxRoot, RenderPolicy } from '../src/index.ts';
import { parseForStore } from '../src/parse.ts';
import { RenderRefused, checkCustomCss } from '../src/render.ts';
import { dangerIn, rootOf, toHtml } from '../test/render-helpers.ts';
import { dialectArbitrary, documentArbitrary, hostileDocumentArbitrary } from './documents.ts';

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

const CSS_FRAGMENTS = [
  '@import "a";',
  '@media (x) {',
  'a { b: ',
  'url(',
  '"',
  "'",
  '\\',
  '\\75 rl(',
  'expression(',
  '/*',
  '*/',
  '}',
  '{',
  ';',
  '</style>',
];

const cssArbitrary = fc
  .array(fc.oneof(fc.constantFrom(...CSS_FRAGMENTS), fc.string({ maxLength: 6 })), {
    maxLength: 30,
  })
  .map((parts) => parts.join(''));

// A refusal is an answer. Anything else thrown is a crash, and anything dangerous in the output
// is worse.
function rendersInert(tree: unknown): boolean {
  try {
    return dangerIn(toHtml(tree as MdxRoot, POLICY)).length === 0;
  } catch (error) {
    return error instanceof RenderRefused;
  }
}

// Throwing, or printing anything other than the input, is a failure. A refusal is fine as
// long as it comes back as a Result.
export function fuzz({ seconds, seed, check }: FuzzOptions): FuzzReport {
  const property = fc.property(
    documentArbitrary,
    hostileDocumentArbitrary,
    dialectArbitrary,
    fc.anything({ maxDepth: 3 }),
    cssArbitrary,
    (source, hostile, dialect, junk, css) => {
      const result = parseForStore(source, dialect, POLICY);
      if (result.ok && serialize(result.value.ast) !== source) return false;
      if (result.ok && !rendersInert(result.value.ast)) return false;
      const page = parseForStore(hostile, dialect, POLICY);
      if (page.ok && !rendersInert(page.value.ast)) return false;
      if (!rendersInert(junk) || !rendersInert(rootOf([junk]))) return false;
      checkCustomCss(css);
      return check === undefined || check(source);
    },
  );
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

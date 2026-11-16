import { DEFAULT_FIRST_RESPONSE_BYTES, HARD_FIRST_RESPONSE_BYTES } from '../src/config.ts';
import type { Surface } from '../src/types.ts';

// The public page budgets, measured on built pages in a browser. The renderer enforces the
// same JS limits from declared sizes; these check what a browser actually loads.
export const JS_LIMIT_BYTES: Readonly<Record<Surface, number>> = {
  docs: 90_000,
  status: 50_000,
};

export const LIGHTHOUSE_MIN_SCORE: Readonly<Record<Surface, number>> = {
  docs: 95,
  status: 98,
};

export const LIGHTHOUSE_CATEGORIES = [
  'performance',
  'accessibility',
  'best-practices',
  'seo',
] as const;
export type LighthouseCategory = (typeof LIGHTHOUSE_CATEGORIES)[number];

// Status only, under Lighthouse's own mobile throttling rather than field data.
export const STATUS_LCP_MS = 1_000;

export const FIRST_RESPONSE_WARN_BYTES = DEFAULT_FIRST_RESPONSE_BYTES;
export const FIRST_RESPONSE_FAIL_BYTES = HARD_FIRST_RESPONSE_BYTES;

export type Scores = Readonly<Record<LighthouseCategory, number | null>>;

// Every shortfall in one list, so a page that misses two budgets says so in one run.
export function lighthouseProblems(surface: Surface, scores: Scores, lcpMs: number): string[] {
  const min = LIGHTHOUSE_MIN_SCORE[surface];
  const problems: string[] = [];
  for (const category of LIGHTHOUSE_CATEGORIES) {
    const score = scores[category];
    if (score === null) problems.push(`${category} has no score`);
    else if (score < min) problems.push(`${category} ${String(score)} is under ${String(min)}`);
  }
  if (surface === 'status' && !(lcpMs <= STATUS_LCP_MS)) {
    problems.push(`LCP ${String(Math.round(lcpMs))} ms is over ${String(STATUS_LCP_MS)} ms`);
  }
  return problems;
}

// Under the limit, as the renderer counts it: a page at the limit is over.
export function jsProblem(surface: Surface, gzipBytes: number): string | undefined {
  const limit = JS_LIMIT_BYTES[surface];
  return gzipBytes < limit
    ? undefined
    : `${String(gzipBytes)} gzipped bytes of JS is not under ${String(limit)}`;
}

export type FirstResponse = 'ok' | 'warn' | 'fail';

export function firstResponseVerdict(gzipBytes: number): FirstResponse {
  if (gzipBytes >= FIRST_RESPONSE_FAIL_BYTES) return 'fail';
  if (gzipBytes >= FIRST_RESPONSE_WARN_BYTES) return 'warn';
  return 'ok';
}

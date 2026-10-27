// Sizes are gzipped bytes; a KB here is 1000 bytes, the stricter reading of the budget.
export const KB = 1000;
export const ROUTE_BUDGET_BYTES = 150 * KB;
export const BASELINE_GROWTH_LIMIT = 0.05;

export interface ScriptSize {
  readonly url: string;
  readonly gzipBytes: number;
}

export interface RouteReport {
  readonly route: string;
  readonly totalBytes: number;
  // Bytes of scripts the empty baseline route does not load.
  readonly beyondBaselineBytes: number;
  readonly overBudget: boolean;
}

export interface BaselineReport {
  readonly recordedBytes: number;
  readonly measuredBytes: number;
  // measured over recorded minus one; negative when it shrank.
  readonly growth: number;
  readonly ok: boolean;
}

// Scripts are counted once per URL, as the browser caches them. Only scripts the baseline
// route does not load count against the budget.
export function routeReport(
  route: string,
  scripts: readonly ScriptSize[],
  baseline: readonly ScriptSize[],
): RouteReport {
  const unique = new Map(scripts.map((s) => [s.url, s.gzipBytes]));
  const framework = new Set(baseline.map((s) => s.url));
  let totalBytes = 0;
  let beyondBaselineBytes = 0;
  for (const [url, bytes] of unique) {
    totalBytes += bytes;
    if (!framework.has(url)) beyondBaselineBytes += bytes;
  }
  return {
    route,
    totalBytes,
    beyondBaselineBytes,
    overBudget: beyondBaselineBytes > ROUTE_BUDGET_BYTES,
  };
}

export function baselineReport(recordedBytes: number, measuredBytes: number): BaselineReport {
  if (!Number.isSafeInteger(recordedBytes) || recordedBytes <= 0) {
    throw new RangeError('The recorded baseline must be a positive whole number of bytes.');
  }
  const grown = measuredBytes - recordedBytes;
  return {
    recordedBytes,
    measuredBytes,
    growth: grown / recordedBytes,
    // Compared in whole bytes, so 5 percent exactly passes without float rounding.
    ok: grown <= recordedBytes * BASELINE_GROWTH_LIMIT,
  };
}

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

// TODO(#59)
export const routeReport: (
  route: string,
  scripts: readonly ScriptSize[],
  baseline: readonly ScriptSize[],
) => RouteReport = (route) => ({ route, totalBytes: 0, beyondBaselineBytes: 0, overBudget: false });

// TODO(#59)
export const baselineReport: (recordedBytes: number, measuredBytes: number) => BaselineReport = (
  recordedBytes,
  measuredBytes,
) => ({ recordedBytes, measuredBytes, growth: 0, ok: true });

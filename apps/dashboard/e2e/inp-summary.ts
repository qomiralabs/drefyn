export const BUDGET_MS = 200;
// Runners differ by half between runs: one read a row press at 160 ms, the next at 248 ms, on
// the same code. So a shared runner only catches a real jump, and the budget itself is held on
// a quiet machine, the same way the auth latency targets are.
export const SHARED_RUNNER_CEILING_MS = 300;

export const inpLimit = (env: Readonly<Record<string, string | undefined>>): number =>
  env['DREFYN_QUIET_BENCH'] === 'on' ? BUDGET_MS : SHARED_RUNNER_CEILING_MS;

// The budget is a p75 target, so the quiet bench holds p75. A shared runner holds its ceiling
// at the median, because its tail is the runner's neighbours, not the page.
export const inpFigure = (env: Readonly<Record<string, string | undefined>>): 'p75' | 'median' =>
  env['DREFYN_QUIET_BENCH'] === 'on' ? 'p75' : 'median';

export interface InpSummary {
  readonly name: string;
  readonly samples: number;
  readonly min: number;
  readonly median: number;
  readonly p75: number;
  readonly max: number;
}

// Nearest rank, so every figure is a value the browser really reported.
const rank = (sorted: readonly number[], share: number): number => {
  const value = sorted[Math.ceil(share * sorted.length) - 1];
  if (value === undefined) throw new Error('no samples');
  return value;
};

export function summarize(name: string, values: readonly number[]): InpSummary {
  const sorted = values.toSorted((a, b) => a - b);
  return {
    name,
    samples: sorted.length,
    min: rank(sorted, 1 / sorted.length),
    median: rank(sorted, 0.5),
    p75: rank(sorted, 0.75),
    max: rank(sorted, 1),
  };
}

export const describeInp = ({ name, samples, min, median, p75, max }: InpSummary): string =>
  `INP ${name}: median ${String(median)} ms, p75 ${String(p75)} ms, spread ${String(min)} to ${String(max)} ms over ${String(samples)} samples`;

// Says so in the log when a shared runner reads over budget, so a pass there hides nothing.
export const overBudget = ({ name, median }: InpSummary): string | null =>
  median < BUDGET_MS
    ? null
    : `INP ${name}: median ${String(median)} ms is over the ${String(BUDGET_MS)} ms budget`;

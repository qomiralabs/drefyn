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

export interface Budget {
  readonly maxDepth: number;
  readonly maxValues: number;
  readonly maxChars: number;
}

export type BudgetMiss = 'depth' | 'size';

// Runs before zod. Its recursive parsers would overflow the stack on hostile nesting, or
// never end on a cycle, and this loop cannot do either. Lengths count before anything is
// queued, so a huge or sparse array costs one step.
export function exceedsBudget(input: unknown, budget: Budget): BudgetMiss | null {
  const pending: { readonly value: unknown; readonly depth: number }[] = [
    { value: input, depth: 0 },
  ];
  let values = 0;
  let chars = 0;
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { value, depth } = next;
    if (typeof value === 'string') {
      chars += value.length;
      if (chars > budget.maxChars) return 'size';
      continue;
    }
    if (typeof value !== 'object' || value === null) continue;
    if (depth >= budget.maxDepth) return 'depth';
    const children: readonly unknown[] = Array.isArray(value)
      ? value
      : Object.entries(value).flat();
    values += children.length;
    if (values > budget.maxValues) return 'size';
    for (const child of children) pending.push({ value: child, depth: depth + 1 });
  }
  return null;
}

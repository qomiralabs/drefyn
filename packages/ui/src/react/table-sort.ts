export type SortDirection = 'ascending' | 'descending';

// Words compare as people read them: case and accents aside, and numbers inside by value,
// so "Page 2" comes before "Page 10".
const words = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

const compare = (a: string | number, b: string | number): number =>
  typeof a === 'number' && typeof b === 'number' ? a - b : words.compare(String(a), String(b));

// A new array in the column's order. Equal rows keep the order they came in, in both
// directions, so a second sort never shuffles rows that tie.
export function sortRows<Row>(
  rows: readonly Row[],
  value: (row: Row) => string | number,
  direction: SortDirection,
): Row[] {
  const sign = direction === 'ascending' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, key: value(row) }))
    .sort((a, b) => sign * compare(a.key, b.key) || a.index - b.index)
    .map(({ row }) => row);
}

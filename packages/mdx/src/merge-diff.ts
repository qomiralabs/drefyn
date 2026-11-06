export type Pair = readonly [number, number];

// For an index the code around it has just proved is in range.
export const at = <T>(list: ArrayLike<T>, index: number) => list[index] as T;

// Two rows are enough for a score, so the table never exists: 20,000 blocks against 20,000 would
// be 1.6 GB, and one hostile page should not get to ask for that.
function scores(a: Int32Array, b: Int32Array): Uint32Array {
  let row = new Uint32Array(b.length + 1);
  let next = new Uint32Array(b.length + 1);
  for (const item of a) {
    for (let j = 0; j < b.length; j += 1) {
      next[j + 1] = item === b[j] ? at(row, j) + 1 : Math.max(at(next, j), at(row, j + 1));
    }
    [row, next] = [next, row];
  }
  return row;
}

// Hirschberg's split: score each half against b, cut b where the scores peak, solve both parts.
function solve(a: Int32Array, b: Int32Array, atA: number, atB: number, pairs: Pair[]): void {
  if (a.length === 0 || b.length === 0) return;
  if (a.length === 1) {
    const found = b.indexOf(at(a, 0));
    if (found !== -1) pairs.push([atA, atB + found]);
    return;
  }
  const middle = a.length >> 1;
  const left = scores(a.subarray(0, middle), b);
  const right = scores(a.slice(middle).reverse(), b.slice().reverse());
  let cut = 0;
  let best = -1;
  for (let j = 0; j <= b.length; j += 1) {
    const total = at(left, j) + at(right, b.length - j);
    if (total > best) {
      best = total;
      cut = j;
    }
  }
  solve(a.subarray(0, middle), b.subarray(0, cut), atA, atB, pairs);
  solve(a.subarray(middle), b.subarray(cut), atA + middle, atB + cut, pairs);
}

const indexesIn = (list: readonly number[], start: number, end: number, other: Set<number>) => {
  const kept: number[] = [];
  for (let index = start; index < end; index += 1) {
    if (other.has(at(list, index))) kept.push(index);
  }
  return kept;
};

// Longest common subsequence as index pairs, in order. An item only one list holds cannot match,
// so those go first, and a page rewritten end to end costs nothing. Time is the product of what
// is left, so maxCells lets a caller refuse work it would rather call a conflict.
export function commonPairs(
  a: readonly number[],
  b: readonly number[],
  maxCells = Infinity,
): readonly Pair[] | undefined {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const keptA = indexesIn(a, start, endA, new Set(b.slice(start, endB)));
  const keptB = indexesIn(b, start, endB, new Set(a.slice(start, endA)));
  if (keptA.length * keptB.length > maxCells) return undefined;

  const pairs: Pair[] = [];
  for (let index = 0; index < start; index += 1) pairs.push([index, index]);
  const middle: Pair[] = [];
  const valuesOf = (list: readonly number[], kept: readonly number[]) =>
    Int32Array.from(kept, (index) => at(list, index));
  solve(valuesOf(a, keptA), valuesOf(b, keptB), 0, 0, middle);
  for (const [i, j] of middle) pairs.push([at(keptA, i), at(keptB, j)]);
  for (let index = 0; index < a.length - endA; index += 1) {
    pairs.push([endA + index, endB + index]);
  }
  return pairs;
}

// Numbers compare in one step, and hashes and words are all this ever sees.
export function interned(...lists: readonly (readonly string[])[]): readonly number[][] {
  const ids = new Map<string, number>();
  return lists.map((list) =>
    list.map((item) => {
      const known = ids.get(item);
      if (known !== undefined) return known;
      ids.set(item, ids.size);
      return ids.size - 1;
    }),
  );
}

// Enough for a paragraph of 2,000 words rewritten end to end. Past that a person decides, which
// costs nothing, where the alignment would hold a thread for the whole of its kill.
const MAX_INLINE_CELLS = 4_000_000;

const sameRange = (
  left: readonly number[],
  leftStart: number,
  leftEnd: number,
  right: readonly number[],
  rightStart: number,
  rightEnd: number,
) => {
  if (leftEnd - leftStart !== rightEnd - rightStart) return false;
  for (let index = 0; index < leftEnd - leftStart; index += 1) {
    if (left[leftStart + index] !== right[rightStart + index]) return false;
  }
  return true;
};

const matchesOf = (pairs: readonly Pair[]) => new Map(pairs);

// diff3 over items. Runs between items all three share are settled alone: one side changed it,
// both changed it the same way, or nobody can say and the answer is undefined.
export function mergeSequences(
  base: readonly string[],
  ours: readonly string[],
  theirs: readonly string[],
): readonly string[] | undefined {
  const [baseIds, oursIds, theirsIds] = interned(base, ours, theirs) as [
    number[],
    number[],
    number[],
  ];
  const toOurs = commonPairs(baseIds, oursIds, MAX_INLINE_CELLS);
  const toTheirs = commonPairs(baseIds, theirsIds, MAX_INLINE_CELLS);
  if (toOurs === undefined || toTheirs === undefined) return undefined;
  const inOurs = matchesOf(toOurs);
  const inTheirs = matchesOf(toTheirs);

  const merged: string[] = [];
  let baseAt = 0;
  let oursAt = 0;
  let theirsAt = 0;
  const settle = (baseEnd: number, oursEnd: number, theirsEnd: number) => {
    const oursKept = sameRange(baseIds, baseAt, baseEnd, oursIds, oursAt, oursEnd);
    const theirsKept = sameRange(baseIds, baseAt, baseEnd, theirsIds, theirsAt, theirsEnd);
    const agreed = sameRange(oursIds, oursAt, oursEnd, theirsIds, theirsAt, theirsEnd);
    if (!oursKept && !theirsKept && !agreed) return false;
    if (oursKept) merged.push(...theirs.slice(theirsAt, theirsEnd));
    else merged.push(...ours.slice(oursAt, oursEnd));
    return true;
  };

  for (let index = 0; index < base.length; index += 1) {
    const oursMatch = inOurs.get(index);
    const theirsMatch = inTheirs.get(index);
    if (oursMatch === undefined || theirsMatch === undefined) continue;
    if (!settle(index, oursMatch, theirsMatch)) return undefined;
    merged.push(at(base, index));
    baseAt = index + 1;
    oursAt = oursMatch + 1;
    theirsAt = theirsMatch + 1;
  }
  return settle(base.length, ours.length, theirs.length) ? merged : undefined;
}

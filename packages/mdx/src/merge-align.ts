import { at, commonPairs, interned } from './merge-diff.ts';
import type { BlockSource } from './types.ts';

// The merge walks any level of a tree, where mdast's own unions say too much to be useful.
export interface MergeNode {
  readonly type: string;
  readonly children?: readonly MergeNode[];
  readonly value?: unknown;
  readonly source?: BlockSource;
  readonly [key: string]: unknown;
}

export interface Entry {
  readonly node: MergeNode;
  readonly hash: string;
  // Hash of the block above this one in its own document. A kept gap only holds beside that.
  readonly previous: string | null;
  words?: ReadonlySet<string>;
}

// A block a side has where the base has none.
export interface Inserted extends Entry {
  // Where it sits: the index into `after`.
  readonly spot: number;
  // The base slot it came from, if this is a move and not new content.
  movedFrom?: number;
}

export type Slot =
  | { readonly state: 'deleted' }
  | { readonly state: 'same' | 'changed'; readonly entry: Entry }
  | { readonly state: 'moved'; readonly entry: Inserted; readonly edited: boolean };

export interface Alignment {
  readonly slots: readonly Slot[];
  // after[i + 1] sits after slot i, so after[0] is above the first block.
  readonly after: readonly (readonly Inserted[])[];
}

const DELETED: Slot = { state: 'deleted' };

function textOf(node: MergeNode): string {
  if (typeof node.value === 'string') return node.value;
  return (node.children ?? []).map(textOf).join(' ');
}

const WORD = /[\p{L}\p{N}_]+/gu;

export function wordsOf(entry: Entry): ReadonlySet<string> {
  entry.words ??= new Set(textOf(entry.node).toLowerCase().match(WORD));
  return entry.words;
}

export interface Budget {
  left: number;
}

// Comparisons and words per side. A rewritten 20,000 block page would otherwise compare every
// pair, and running out is safe: an unpaired block is a delete and an insert, which still conflict
// with an edit on the other side. Honest merges compare within small runs and never come near it.
// Each side has its own, so swapping them changes nothing.
export const SIMILARITY_BUDGET = 2_000_000;

export function similarity(a: Entry, b: Entry, budget: Budget): number {
  budget.left -= 1;
  if (a.node.type !== b.node.type) return 0;
  const left = wordsOf(a);
  const right = wordsOf(b);
  if (left.size === 0 && right.size === 0) return 1;
  budget.left -= left.size;
  if (budget.left < 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

// Whether a block holds every word of another, within the same budget as a comparison.
export function holdsWords(block: Entry, words: ReadonlySet<string>, budget: Budget): boolean {
  budget.left -= words.size;
  if (budget.left < 0) return false;
  const held = wordsOf(block);
  for (const word of words) if (!held.has(word)) return false;
  return true;
}

// Half the words in common is about where a person stops calling two blocks one block.
const SAME_BLOCK = 0.5;

function closest(
  candidates: readonly number[],
  base: readonly Entry[],
  entry: Entry,
  budget: Budget,
): number | undefined {
  let best: number | undefined;
  let score = 0;
  for (const index of candidates) {
    if (budget.left < 0) break;
    const value = similarity(at(base, index), entry, budget);
    if (value >= SAME_BLOCK && value > score) {
      score = value;
      best = index;
    }
  }
  return best;
}

const movable = (slot: Slot, entry: Entry) =>
  slot.state === 'deleted' && entry.node.type !== 'yaml';

const range = (start: number, end: number) =>
  Array.from({ length: Math.max(end - start, 0) }, (_, index) => start + index);

function detectMoves(
  base: readonly Entry[],
  slots: Slot[],
  after: readonly (readonly Inserted[])[],
  budget: Budget,
): void {
  const deleted = new Map<string, number[]>();
  for (const [index, slot] of slots.entries()) {
    const entry = at(base, index);
    if (!movable(slot, entry)) continue;
    const copies = deleted.get(entry.hash);
    if (copies === undefined) deleted.set(entry.hash, [index]);
    else copies.push(index);
  }
  const inserted = after.flat();
  for (const entry of inserted) {
    const index = deleted.get(entry.hash)?.shift();
    if (index === undefined) continue;
    slots[index] = { state: 'moved', entry, edited: false };
    entry.movedFrom = index;
  }
  // Moved and edited, so the other side's delete or edit still has to meet it.
  let open = slots.flatMap((slot, index) => (movable(slot, at(base, index)) ? [index] : []));
  for (const entry of inserted) {
    if (budget.left < 0) return;
    if (entry.movedFrom !== undefined) continue;
    const index = closest(open, base, entry, budget);
    if (index === undefined) continue;
    slots[index] = { state: 'moved', entry, edited: true };
    entry.movedFrom = index;
    open = open.filter((slot) => slot !== index);
  }
}

// Lines one side up against the base. What the hashes cannot match pairs by similarity, in
// order, so an insert beside an edit cannot steal the edit's slot. A block with an exact copy in
// the base is never an edit of something else: that is a move.
export function align(base: readonly Entry[], side: readonly Entry[]): Alignment {
  const budget = { left: SIMILARITY_BUDGET };
  const slots: Slot[] = base.map(() => DELETED);
  const after: Inserted[][] = Array.from({ length: base.length + 1 }, () => []);
  const known = new Set(base.map(({ hash }) => hash));
  const add = (slot: number, entry: Entry) => {
    at(after, slot + 1).push({ ...entry, spot: slot + 1 });
  };

  let nextBase = 0;
  let nextSide = 0;
  const pairUp = (baseEnd: number, sideEnd: number) => {
    let from = nextBase;
    let last = nextBase - 1;
    for (let index = nextSide; index < sideEnd; index += 1) {
      const entry = at(side, index);
      const paired =
        known.has(entry.hash) || budget.left < 0
          ? undefined
          : closest(range(from, baseEnd), base, entry, budget);
      if (paired === undefined) {
        add(last, entry);
        continue;
      }
      slots[paired] = { state: 'changed', entry };
      from = paired + 1;
      last = paired;
    }
  };

  const [baseIds, sideIds] = interned(
    base.map(({ hash }) => hash),
    side.map(({ hash }) => hash),
  ) as [number[], number[]];
  for (const [baseIndex, sideIndex] of commonPairs(baseIds, sideIds) ?? []) {
    pairUp(baseIndex, sideIndex);
    slots[baseIndex] = { state: 'same', entry: at(side, sideIndex) };
    nextBase = baseIndex + 1;
    nextSide = sideIndex + 1;
  }
  pairUp(base.length, side.length);
  detectMoves(base, slots, after, budget);
  return { slots, after };
}

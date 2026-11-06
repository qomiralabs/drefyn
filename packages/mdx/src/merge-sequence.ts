import { rawOf } from './canonical.ts';
import { align, holdsWords, SIMILARITY_BUDGET, similarity, wordsOf } from './merge-align.ts';
import type { Alignment, Budget, Entry, Inserted, MergeNode, Slot } from './merge-align.ts';
import { at } from './merge-diff.ts';
import {
  childrenOf,
  isEmptied,
  mergedEntry,
  mergeNode,
  settle,
  withoutSource,
} from './merge-nodes.ts';
import type { MergeContext } from './merge-nodes.ts';
import type { BlockConflictReason, MdxBlock } from './types.ts';

// Conflicts hold entries until the end, so nothing here deals in stored shapes.
export interface SlotConflict {
  readonly baseIndex: number | null;
  readonly ours: Entry | null;
  readonly theirs: Entry | null;
  readonly reason: BlockConflictReason;
}

export interface MergedSequence {
  readonly items: readonly Entry[];
  readonly conflicts: readonly SlotConflict[];
}

type Moved = Extract<Slot, { state: 'moved' }>;

const hashOf = (node: MergeNode) => rawOf(node as unknown as MdxBlock);

export const entriesOf = (nodes: readonly MergeNode[]): readonly Entry[] =>
  nodes.map((node) => ({ node, hash: hashOf(node), previous: null }));

const entryOf = (slot: Slot): Entry | null => (slot.state === 'deleted' ? null : slot.entry);
const moved = (slot: Slot): slot is Moved => slot.state === 'moved';

const keyOf = ({ node: { source } }: Entry) =>
  source === undefined ? '' : `${source.gapBefore}\0${source.raw}`;

// Both sides hold this tree, so the only question is whose bytes. A reformat beats the base, and
// two reformats settle on the same one whichever side comes first.
function bytesOf(base: Entry, ours: Entry, theirs: Entry): Entry {
  const [was, mine, other] = [base, ours, theirs].map(keyOf) as [string, string, string];
  if (mine === was) return theirs;
  if (other === was) return ours;
  return mine < other ? ours : theirs;
}

const RUNS_OF_ITEMS = new Set(['list', 'blockquote', 'table']);

const itemsOf = ({ node }: Entry): readonly MergeNode[] =>
  RUNS_OF_ITEMS.has(node.type) ? childrenOf(node) : [];

function touches({ slots, after }: Alignment, low: number, high: number): boolean {
  for (let index = low; index <= high; index += 1) {
    if (at(slots, index).state !== 'same') return true;
  }
  for (let index = low; index < high; index += 1) {
    if (at(after, index + 1).length > 0) return true;
  }
  return false;
}

// Blocks a side rewrote, each with the slot it now sits at. A move that kept its words is no
// rewrite, but a block moved and edited can have taken in anything.
const rewritesOf = ({ slots, after }: Alignment): readonly (readonly [Entry, number])[] => {
  const rewritten = ({ movedFrom }: Inserted) => {
    const from = movedFrom === undefined ? undefined : at(slots, movedFrom);
    return from === undefined || (from.state === 'moved' && from.edited);
  };
  return [
    ...slots.flatMap((slot, index) =>
      slot.state === 'changed' ? [[slot.entry, index] as const] : [],
    ),
    ...after.flatMap((list, spot) =>
      list.filter(rewritten).map((entry) => [entry, Math.max(0, spot - 1)] as const),
    ),
  ];
};

// Slots a side's content came from, when it now sits under a different block: items that moved
// between lists, and whole blocks a list took in when the one between them went.
function crossings(
  base: readonly Entry[],
  owners: ReadonlyMap<string, ReadonlySet<number>>,
  alignment: Alignment,
) {
  const { slots, after } = alignment;
  const spans: (readonly [number, number])[] = [];
  const look = (entry: Entry, here: number) => {
    for (const child of itemsOf(entry)) {
      const from = owners.get(hashOf(child));
      if (from === undefined || from.has(here)) continue;
      const first = Math.min(...from);
      spans.push([Math.min(first, here), Math.max(first, here)]);
    }
  };
  slots.forEach((slot, index) => {
    const entry = entryOf(slot);
    if (entry !== null) look(entry, index);
  });
  after.forEach((list, spot) => {
    for (const entry of list) look(entry, Math.max(0, spot - 1));
  });
  const rewrites = rewritesOf(alignment);
  const budget = { left: SIMILARITY_BUDGET };
  slots.forEach((slot, index) => {
    if (slot.state !== 'deleted' || budget.left < 0) return;
    const words = wordsOf(at(base, index));
    if (words.size === 0) return;
    for (const [entry, here] of rewrites) {
      if (holdsWords(entry, words, budget))
        spans.push([Math.min(index, here), Math.max(index, here)]);
    }
  });
  return spans;
}

// Lists fuse and split when the block between them changes, so items cross slots with no trace
// at slot level. If one side did that and the other touched the span, slots have no sound answer.
function crossingConflicts(
  base: readonly Entry[],
  ours: Alignment,
  theirs: Alignment,
  conflict: (index: number, reason: BlockConflictReason, a: Entry | null, c: Entry | null) => void,
) {
  const owners = new Map<string, Set<number>>();
  for (const [index, entry] of base.entries()) {
    for (const child of itemsOf(entry)) {
      const hash = hashOf(child);
      const known = owners.get(hash);
      if (known === undefined) owners.set(hash, new Set([index]));
      else known.add(index);
    }
  }
  const seen = new Set<string>();
  for (const [mover, other] of [
    [ours, theirs],
    [theirs, ours],
  ] as const) {
    for (const [low, high] of crossings(base, owners, mover)) {
      const key = `${low}:${high}`;
      if (seen.has(key) || !touches(other, low, high)) continue;
      seen.add(key);
      conflict(low, 'both_changed', entryOf(at(ours.slots, low)), entryOf(at(theirs.slots, low)));
    }
  }
}

// Slot by slot against the base. Every path that does not place a block either honours a delete
// or records a conflict, which is what makes a silent loss a bug and not a choice.
export function mergeSequence(
  base: readonly Entry[],
  oursSide: readonly Entry[],
  theirsSide: readonly Entry[],
  context: MergeContext,
  top: boolean,
): MergedSequence {
  const ours = align(base, oursSide);
  const theirs = align(base, theirsSide);
  const items: Entry[] = [];
  const conflicts: SlotConflict[] = [];
  // Moves both sides agree on, by spot. Taken entries sit there instead of in `after`.
  const shared = new Map<number, Entry[]>();
  const taken = new Set<Inserted>();
  // An edit by one side follows the block the other moved, so a move entry prints this instead.
  const replaced = new Map<number, Entry>();
  // Slots a move has already settled, with the block to leave in place if a conflict kept one.
  const decisions = new Map<number, Entry | 'skip'>();

  const conflict = (
    index: number | null,
    reason: BlockConflictReason,
    a: Entry | null,
    c: Entry | null,
  ) => {
    conflicts.push({ baseIndex: index, reason, ours: a, theirs: c });
  };

  const merged = (slot: Entry, a: MergeNode, c: MergeNode) => {
    const node = mergeNode(slot.node, a, c, context);
    if (node === undefined) return undefined;
    return top ? settle(node, context) : node;
  };

  const open = (list: readonly Inserted[]) => list.filter((entry) => !taken.has(entry));

  const bothMoved = (index: number, a: Moved, c: Moved) => {
    const { spot } = a.entry;
    taken.add(a.entry).add(c.entry);
    if (spot !== c.entry.spot || a.entry.hash !== c.entry.hash) {
      conflict(index, 'move_vs_edit', a.entry, c.entry);
      decisions.set(index, a.entry);
      return;
    }
    shared.set(spot, [...(shared.get(spot) ?? []), a.entry]);
    decisions.set(index, 'skip');
    if (open(at(ours.after, spot)).length > 0 || open(at(theirs.after, spot)).length > 0) {
      conflict(index, 'both_inserted', a.entry, c.entry);
    }
  };

  // A move next to the other side's insert leaves that insert with no place to mean.
  const insertBeside = (index: number, mover: Alignment, other: Alignment) => {
    const gone = (slot: number) => {
      const state = mover.slots[slot]?.state;
      return state === 'deleted' || state === 'moved';
    };
    let low = index;
    let high = index;
    while (gone(low - 1)) low -= 1;
    while (gone(high + 1)) high += 1;
    for (let spot = low; spot <= high + 1; spot += 1) {
      if (at(other.after, spot).length > 0) return true;
    }
    return false;
  };

  const oneMoved = (index: number, slot: Entry, a: Slot, c: Slot) => {
    const oursMoved = moved(a);
    const move = (oursMoved ? a : c) as Moved;
    const other = oursMoved ? c : a;
    decisions.set(index, 'skip');
    if (insertBeside(index, oursMoved ? ours : theirs, oursMoved ? theirs : ours)) {
      conflict(index, 'move_vs_edit', entryOf(a), entryOf(c));
    }
    if (other.state === 'same') return;
    if (other.state !== 'changed') {
      conflict(index, 'move_vs_edit', entryOf(a), entryOf(c));
      return;
    }
    if (!move.edited) {
      replaced.set(index, other.entry);
      return;
    }
    const [mine, others] = oursMoved ? [move.entry, other.entry] : [other.entry, move.entry];
    const node = merged(slot, mine.node, others.node);
    if (node === undefined) conflict(index, 'move_vs_edit', mine, others);
    else replaced.set(index, mergedEntry(slot, node, hashOf(node)));
  };

  for (const [index, slot] of base.entries()) {
    const a = at(ours.slots, index);
    const c = at(theirs.slots, index);
    if (moved(a) && moved(c)) bothMoved(index, a, c);
    else if (moved(a) || moved(c)) oneMoved(index, slot, a, c);
  }

  if (top) crossingConflicts(base, ours, theirs, conflict);

  const live = (list: readonly Inserted[]): readonly Entry[] =>
    list.map((entry) => {
      const edited = entry.movedFrom === undefined ? undefined : replaced.get(entry.movedFrom);
      return edited ?? entry;
    });

  const placeInserts = (spot: number) => {
    items.push(...(shared.get(spot) ?? []));
    const a = open(at(ours.after, spot));
    const c = open(at(theirs.after, spot));
    if (a.length === 0 || c.length === 0) {
      items.push(...live(a), ...live(c));
      return;
    }
    if (a.length === c.length && a.every(({ hash }, index) => hash === at(c, index).hash)) {
      items.push(...live(a));
      return;
    }
    const slot = spot === 0 ? null : spot - 1;
    for (let index = 0; index < Math.max(a.length, c.length); index += 1) {
      conflict(slot, 'both_inserted', a[index] ?? null, c[index] ?? null);
    }
    items.push(...live(a), ...live(c));
  };

  // A rewrite too different to pair still answers a delete: same kind, same place, a word shared.
  const rewriteNear = (index: number, side: Alignment, other: Alignment): Entry | null => {
    const beside = [...at(side.after, index), ...at(side.after, index + 1)];
    const theirsToo = new Set(
      [...at(other.after, index), ...at(other.after, index + 1)].map(({ hash }) => hash),
    );
    const budget = { left: Infinity };
    const found = beside.find(
      (entry) =>
        entry.movedFrom === undefined &&
        similarity(at(base, index), entry, budget) > 0 &&
        !theirsToo.has(entry.hash),
    );
    return found ?? null;
  };

  // Blocks can fuse: an indented block moved beside another becomes one code block. Then the
  // slot reads as deleted on that side while its words live on inside a block it rewrote.
  const oursRewrites = rewritesOf(ours).map(([entry]) => entry);
  const theirsRewrites = rewritesOf(theirs).map(([entry]) => entry);
  const oursBudget = { left: SIMILARITY_BUDGET };
  const theirsBudget = { left: SIMILARITY_BUDGET };

  const absorbedBy = (slot: Entry, list: readonly Entry[], budget: Budget): Entry | null => {
    const words = wordsOf(slot);
    if (words.size === 0 || budget.left < 0) return null;
    const holder = list.find((entry) => holdsWords(entry, words, budget));
    return holder ?? null;
  };

  const placeBoth = (index: number, slot: Entry, a: Entry, c: Entry) => {
    const node = merged(slot, a.node, c.node);
    if (node === undefined) {
      conflict(index, 'both_changed', a, c);
      items.push(a);
    } else if (!isEmptied(node)) {
      items.push(mergedEntry(slot, node, hashOf(node)));
    }
  };

  const placeSlot = (index: number, slot: Entry) => {
    const a = at(ours.slots, index);
    const c = at(theirs.slots, index);
    if (a.state === 'deleted' && c.state === 'deleted') {
      const oursNear =
        rewriteNear(index, ours, theirs) ?? absorbedBy(slot, oursRewrites, oursBudget);
      const theirsNear =
        rewriteNear(index, theirs, ours) ?? absorbedBy(slot, theirsRewrites, theirsBudget);
      if (oursNear !== null || theirsNear !== null) {
        conflict(index, 'delete_vs_edit', oursNear, theirsNear);
      }
    } else if (a.state === 'deleted' || c.state === 'deleted') {
      const kept = a.state === 'deleted' ? c : a;
      if (kept.state !== 'changed') return;
      conflict(index, 'delete_vs_edit', entryOf(a), entryOf(c));
      items.push(kept.entry);
    } else {
      const [mine, others] = [a.entry, c.entry];
      if (mine.hash === others.hash) items.push(bytesOf(slot, mine, others));
      else if (a.state === 'same') items.push(others);
      else if (c.state === 'same') items.push(mine);
      else placeBoth(index, slot, mine, others);
    }
  };

  placeInserts(0);
  for (const [index, slot] of base.entries()) {
    const decision = decisions.get(index);
    if (decision === undefined) placeSlot(index, slot);
    else if (decision !== 'skip') items.push(decision);
    placeInserts(index + 1);
  }
  return { items, conflicts };
}

// Below the top a conflict has nowhere to live, so the whole block goes to a person.
export function mergeChildren(
  base: MergeNode,
  ours: MergeNode,
  theirs: MergeNode,
  context: MergeContext,
): readonly MergeNode[] | undefined {
  const { items, conflicts } = mergeSequence(
    entriesOf(childrenOf(base).map(withoutSource)),
    entriesOf(childrenOf(ours).map(withoutSource)),
    entriesOf(childrenOf(theirs).map(withoutSource)),
    context,
    false,
  );
  return conflicts.length > 0 ? undefined : items.map(({ node }) => node);
}

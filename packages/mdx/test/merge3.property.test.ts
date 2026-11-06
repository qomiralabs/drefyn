import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { merge3 } from '../src/merge3.ts';
import { meaningOf } from '../src/meaning.ts';
import { printPage } from '../src/print-job.ts';
import type { BlockConflict, Dialect, MdxRoot, MergeOutcome } from '../src/index.ts';
import { isolatedPolicy, parsed } from './helpers.ts';
import { applyEdits, corpusPages, generatedPage, mergeCaseArbitrary } from './merge3-generators.ts';
import type { MergeCase, Side, Tree } from './merge3-generators.ts';

// A full 100,000 takes minutes, so the gate runs a slice with a fresh seed every time and
// `pnpm --filter @drefyn/mdx test:merge` runs the whole of it.
const RUNS = Number(process.env['MERGE_PROPERTY_RUNS'] ?? 2_000);
const SEED = process.env['MERGE_PROPERTY_SEED'];
const TIMEOUT_MS = Math.max(120_000, RUNS * 30);

const TOKEN = /\b(?:u\d+|[OT]\d+)\b/g;
const LEAF = new Set(['paragraph', 'heading', 'tableCell', 'code']);

interface Leaves {
  // Token to the leaf that holds it, and to its top level block.
  readonly leaf: ReadonlyMap<string, number>;
  readonly top: ReadonlyMap<string, number>;
  readonly order: readonly string[];
}

// Source bytes can hold words a tree moved on from, so only the tree counts.
const wordsIn = (node: object): readonly string[] =>
  JSON.stringify({ ...node, source: undefined }).match(TOKEN) ?? [];

function leavesOf(root: MdxRoot): Leaves {
  const leaf = new Map<string, number>();
  const top = new Map<string, number>();
  const order: string[] = [];
  let leaves = 0;
  const walk = (node: Tree, block: number) => {
    if (LEAF.has(node.type)) {
      leaves += 1;
      for (const word of wordsIn(node)) {
        order.push(word);
        top.set(word, block);
        if (!leaf.has(word)) leaf.set(word, leaves);
      }
      return;
    }
    for (const child of node.children ?? []) walk(child, block);
  };
  (root.children as unknown as readonly Tree[]).forEach(walk);
  return { leaf, top, order };
}

const firstSeen = (order: readonly string[]) => {
  const places = new Map<string, number>();
  order.forEach((word, index) => {
    if (!places.has(word)) places.set(word, index);
  });
  return places;
};

const keyOf = (conflicts: readonly BlockConflict[]) =>
  conflicts.map(({ baseIndex, reason }) => `${baseIndex ?? 'top'}:${reason}`).sort();

const treeOf = ({ kind, ...outcome }: MergeOutcome) =>
  kind === 'clean'
    ? (outcome as { merged: MdxRoot }).merged
    : (outcome as { partial: MdxRoot }).partial;

const conflictsOf = (outcome: MergeOutcome) =>
  outcome.kind === 'conflict' ? outcome.conflicts : [];

const recordedWords = (conflicts: readonly BlockConflict[]) => {
  const words = new Set<string>();
  for (const { ours, theirs } of conflicts) {
    for (const block of [ours, theirs]) {
      if (block === null) continue;
      for (const word of wordsIn(block)) words.add(word);
    }
  }
  return words;
};

// A word in a moved block goes where the mover put it, as does a word sharing a block with it.
function travelling(moved: ReadonlySet<string>, documents: readonly Leaves[]) {
  const words = new Set(moved);
  for (const { top } of documents) {
    const blocks = new Set<number>();
    for (const word of moved) {
      const block = top.get(word);
      if (block !== undefined) blocks.add(block);
    }
    for (const [word, block] of top) if (blocks.has(block)) words.add(word);
  }
  return words;
}

function checkPlacement(
  merged: Leaves,
  ours: Leaves,
  theirs: Leaves,
  movedOurs: ReadonlySet<string>,
  movedTheirs: ReadonlySet<string>,
): string | undefined {
  const inMerge = [...firstSeen(merged.order).keys()];
  const placeOurs = firstSeen(ours.order);
  const placeTheirs = firstSeen(theirs.order);
  for (const [index, first] of inMerge.entries()) {
    for (const second of inMerge.slice(index + 1)) {
      const a = placeOurs.get(first);
      const b = placeOurs.get(second);
      const c = placeTheirs.get(first);
      const d = placeTheirs.get(second);
      const moverOurs = movedOurs.has(first) || movedOurs.has(second);
      const moverTheirs = movedTheirs.has(first) || movedTheirs.has(second);
      if (moverOurs && moverTheirs) continue;
      const brokenOurs = a !== undefined && b !== undefined && a > b && !moverTheirs;
      const brokenTheirs = c !== undefined && d !== undefined && c > d && !moverOurs;
      if (brokenOurs || brokenTheirs) return `${first} and ${second} changed order`;
    }
  }
  return undefined;
}

// Words a side keeps in one leaf stay in one leaf, unless the other side itself pulled them apart.
function checkMembership(merged: Leaves, sides: readonly Leaves[]): string | undefined {
  for (const { leaf } of sides) {
    const groups = new Map<number, string[]>();
    for (const [word, place] of leaf) groups.set(place, [...(groups.get(place) ?? []), word]);
    for (const words of groups.values()) {
      const [first, ...rest] = words.filter((word) => merged.leaf.has(word));
      if (first === undefined) continue;
      for (const word of rest) {
        if (merged.leaf.get(word) === merged.leaf.get(first)) continue;
        const apart = sides.some(
          (side) =>
            side.leaf.has(word) &&
            side.leaf.has(first) &&
            side.leaf.get(word) !== side.leaf.get(first),
        );
        if (!apart) return `${first} and ${word} split across leaves`;
      }
    }
  }
  return undefined;
}

function checkPresence(
  outcome: MergeOutcome,
  base: Leaves,
  ours: Leaves,
  theirs: Leaves,
  merged: Leaves,
): string | undefined {
  const recorded = recordedWords(conflictsOf(outcome));
  const words = new Set([...base.leaf.keys(), ...ours.leaf.keys(), ...theirs.leaf.keys()]);
  for (const word of words) {
    const inBase = base.leaf.has(word);
    const inOurs = ours.leaf.has(word);
    const inTheirs = theirs.leaf.has(word);
    const present = merged.leaf.has(word);
    if (!inBase && (inOurs || inTheirs) && !present && !recorded.has(word)) {
      return `lost ${word}: new on one side, not merged and not recorded`;
    }
    if (outcome.kind !== 'clean') continue;
    if (inOurs && inTheirs && !present) return `lost ${word}: both sides kept it`;
    if (inBase && !(inOurs && inTheirs) && present) return `kept ${word}: a side deleted it`;
    if (merged.order.filter((seen) => seen === word).length > 1) return `doubled ${word}`;
  }
  return undefined;
}

const use = isolatedPolicy();

function checkPrints(root: MdxRoot): string | undefined {
  const printed = printPage({ tree: JSON.stringify(root), policy: use });
  if (!printed.ok) return `refused to print: ${printed.error[0]?.code ?? 'unknown'}`;
  if (meaningOf(printed.value.ast.children) !== meaningOf(root.children)) {
    return 'printed bytes parse to something else';
  }
  return undefined;
}

interface Built {
  readonly base: MdxRoot;
  readonly ours: MdxRoot;
  readonly theirs: MdxRoot;
  readonly sideOurs: Side;
  readonly sideTheirs: Side;
}

const pages = corpusPages(600);

function build(input: MergeCase): Built | undefined {
  const page =
    'corpus' in input.page
      ? pages[input.page.corpus % pages.length]
      : { text: generatedPage(input.page.seed), dialect: 'md' as Dialect };
  if (page === undefined) return undefined;
  const lines = (text: string) => (input.crlf ? text.replace(/\n/g, '\r\n') : text);
  try {
    const sideOurs = applyEdits(page.text, page.dialect, input.ours, 'O');
    const sideTheirs = applyEdits(page.text, page.dialect, input.theirs, 'T');
    return {
      base: parsed(lines(page.text), page.dialect),
      ours: parsed(lines(sideOurs.text), page.dialect),
      theirs: parsed(lines(sideTheirs.text), page.dialect),
      sideOurs,
      sideTheirs,
    };
  } catch {
    // An edit can leave a page the parser refuses, and that never reaches a merge.
    return undefined;
  }
}

const stats = { clean: 0, conflict: 0, skipped: 0, tracked: 0 };

function failureIn(input: MergeCase): string | undefined {
  const built = build(input);
  if (built === undefined) {
    stats.skipped += 1;
    return undefined;
  }
  const { base, ours, theirs, sideOurs, sideTheirs } = built;
  const result = merge3(base, ours, theirs);
  const swapped = merge3(base, theirs, ours);
  if (!result.ok || !swapped.ok) return 'refused an honest page';
  const outcome = result.value;
  stats[outcome.kind] += 1;
  const tree = treeOf(outcome);
  const documents = [base, ours, theirs, tree].map(leavesOf);
  const [baseLeaves, oursLeaves, theirsLeaves, mergedLeaves] = documents as [
    Leaves,
    Leaves,
    Leaves,
    Leaves,
  ];
  stats.tracked += mergedLeaves.leaf.size;

  const here = keyOf(conflictsOf(outcome));
  const there = keyOf(conflictsOf(swapped.value));
  if (JSON.stringify(here) !== JSON.stringify(there))
    return `not symmetric: ${here.join()} / ${there.join()}`;

  const lost = checkPresence(outcome, baseLeaves, oursLeaves, theirsLeaves, mergedLeaves);
  if (lost !== undefined) return lost;
  if (outcome.kind === 'conflict') return undefined;

  const sides = [oursLeaves, theirsLeaves];
  const movedOurs = travelling(sideOurs.moved, documents);
  const movedTheirs = travelling(sideTheirs.moved, documents);
  const failure =
    checkPlacement(mergedLeaves, oursLeaves, theirsLeaves, movedOurs, movedTheirs) ??
    checkMembership(mergedLeaves, sides) ??
    checkPrints(outcome.merged);
  if (failure !== undefined) return failure;
  const again = treeOf(swapped.value);
  const left = [...mergedLeaves.leaf.keys()].sort();
  const right = [...leavesOf(again).leaf.keys()].sort();
  return JSON.stringify(left) === JSON.stringify(right) ? undefined : 'not symmetric in content';
}

describe('merge3 over generated edits', () => {
  it(
    'loses nothing, places everything, and agrees when the sides swap',
    () => {
      expect(pages.length).toBeGreaterThan(50);
      fc.assert(
        fc.property(mergeCaseArbitrary(pages.length), (input) => {
          expect(failureIn(input)).toBeUndefined();
        }),
        { numRuns: RUNS, ...(SEED === undefined ? {} : { seed: Number(SEED) }) },
      );
      console.log(`merge3 property: ${JSON.stringify({ runs: RUNS, seed: SEED, ...stats })}`);
      // A run that skips most cases or never conflicts would pass and prove nothing.
      expect(stats.skipped).toBeLessThan(RUNS / 10);
      expect(stats.conflict).toBeGreaterThan(RUNS / 100);
      expect(stats.clean).toBeGreaterThan(RUNS / 2);
    },
    TIMEOUT_MS,
  );
});

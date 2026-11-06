import type { MdxRoot } from './types.ts';

// Deliberately on its own: no import from the merge, and its own walk of the tree. A bug in how
// the merge moves content cannot also hide here, and how content moved does not matter to it.

const TEXT_FIELDS = ['value', 'alt', 'url', 'title', 'lang', 'meta', 'name'] as const;

// A word cannot hold a space, so this can never collide with a token from a page.
const LEAFLESS = 'leafless ';

const WHITE_SPACE = /\s+/;

interface Walked {
  readonly type?: unknown;
  readonly children?: readonly unknown[];
  readonly attributes?: readonly unknown[];
  readonly [field: string]: unknown;
}

const add = (counts: Map<string, number>, token: string) => {
  counts.set(token, (counts.get(token) ?? 0) + 1);
};

function addWords(counts: Map<string, number>, text: string) {
  for (const word of text.split(WHITE_SPACE)) if (word !== '') add(counts, word);
}

// Tokens come from the tree, so a reformat changes nothing. It keeps its own stack, and it runs
// on trees that came back from another process, whose depth nobody has checked.
export function tokenCounts(root: MdxRoot): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  const stack: unknown[] = [...root.children];
  while (stack.length > 0) {
    const node = stack.pop() as Walked | null;
    if (typeof node !== 'object' || node === null) continue;
    for (const field of TEXT_FIELDS) {
      const value = node[field];
      if (typeof value === 'string') addWords(counts, value);
    }
    // An attribute written as an expression holds its text one level down.
    if (typeof node['value'] === 'object') stack.push(node['value']);
    for (const child of node.attributes ?? []) stack.push(child);
    for (const child of node.children ?? []) stack.push(child);
    const leafless = (node.children ?? []).length === 0 && typeof node['value'] !== 'string';
    if (leafless) add(counts, `${LEAFLESS}${String(node.type)}`);
  }
  return counts;
}

// How many tokens the three inputs cannot account for in the merged tree. Over the upper bound is
// a delete undone or a duplicate. Under the lower is a lost insert, or a word both sides kept. The
// same edit on both sides counts its words twice in three way arithmetic, so the upper bound
// allows min(ours, theirs), and the lower never asks for more than one side has.
export function unexplainedTokens(
  base: MdxRoot,
  ours: MdxRoot,
  theirs: MdxRoot,
  merged: MdxRoot,
): number {
  const [was, mine, other, now] = [base, ours, theirs, merged].map(tokenCounts) as [
    ReadonlyMap<string, number>,
    ReadonlyMap<string, number>,
    ReadonlyMap<string, number>,
    ReadonlyMap<string, number>,
  ];
  let breaches = 0;
  for (const token of new Set([...was.keys(), ...mine.keys(), ...other.keys(), ...now.keys()])) {
    const left = mine.get(token) ?? 0;
    const right = other.get(token) ?? 0;
    const three = left + right - (was.get(token) ?? 0);
    const upper = Math.max(three, Math.min(left, right));
    const lower = Math.max(0, Math.min(three, Math.max(left, right)));
    const count = now.get(token) ?? 0;
    if (count > upper || count < lower) breaches += 1;
  }
  return breaches;
}

import { digest, sourceOf } from './canonical.ts';
import { unexplainedTokens } from './merge-count.ts';
import type { Entry, MergeNode } from './merge-align.ts';
import { printAlone, withoutSource } from './merge-nodes.ts';
import type { Definitions, MergeContext } from './merge-nodes.ts';
import { mergeChildren, mergeSequence } from './merge-sequence.ts';
import type { SlotConflict } from './merge-sequence.ts';
import { parseForStore } from './parse.ts';
import { DEFAULT_LIMITS, DEFAULT_MERGE_MAX_BLOCKS } from './policy.ts';
import { refused } from './result.ts';
import { rootSchema } from './root-schema.ts';
import { BLANK_LINE } from './serialize.ts';
import { checkTree } from './tree-limits.ts';
import type {
  BlockConflict,
  BlockSource,
  Dialect,
  MdxBlock,
  MdxIssueCode,
  MdxRoot,
  MergeOutcome,
  MergeResult,
  RenderPolicy,
} from './types.ts';

export { DEFAULT_MERGE_MAX_BLOCKS };

export interface MergeOptions {
  readonly maxBlocks?: number;
  readonly policy?: RenderPolicy;
}

// Fragments parse under this only to find their shape. Nothing here is rendered or stored.
const FRAGMENT_POLICY: RenderPolicy = {
  version: 0,
  components: new Set<string>(),
  rawHtml: 'drop',
  remoteImages: 'block',
  linkProtocols: [],
  limits: DEFAULT_LIMITS,
};

interface Unknown {
  readonly type?: unknown;
  readonly children?: unknown;
  readonly attributes?: unknown;
}

const isNode = (value: unknown): value is Unknown =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as Unknown).type === 'string';

// Keeps its own stack, as this runs before depth is known. Everything after it can take a tree
// at its word: a node has a type, and children are a list of nodes.
function wellFormed(children: readonly unknown[]): boolean {
  const stack = [...children];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!isNode(node)) return false;
    const { children: inner, attributes } = node;
    for (const list of [inner, attributes]) {
      if (list === undefined) continue;
      if (!Array.isArray(list)) return false;
      for (const child of list as readonly unknown[]) stack.push(child);
    }
  }
  return true;
}

function withinLimits(root: MdxRoot, policy: RenderPolicy): boolean {
  try {
    checkTree(root.children, policy.limits);
    return true;
  } catch {
    return false;
  }
}

// Undefined when `data` is anywhere in the tree: the hash cannot see it, so two blocks could
// compare equal while one carries props a renderer would honour.
function entriesOfRoot({ children }: MdxRoot): readonly Entry[] | undefined {
  const entries: Entry[] = [];
  let previous: string | null = null;
  for (const block of children) {
    const { rawOf, plain } = digest(block);
    if (!plain) return undefined;
    entries.push({ node: block as unknown as MergeNode, hash: rawOf, previous });
    previous = rawOf;
  }
  return entries;
}

function refusalFor(roots: readonly MdxRoot[], options: Required<MergeOptions>) {
  const { maxBlocks, policy } = options;
  const shaped = roots.every((root) => rootSchema.safeParse(root).success);
  if (!shaped) return 'mdx.block_not_printable';
  if (!roots.every(({ children }) => wellFormed(children))) return 'mdx.block_not_printable';
  if (roots.some(({ dialect }) => dialect !== roots[0]?.dialect)) return 'mdx.dialect_mismatch';
  const fits = roots.every(
    (root) => root.children.length <= maxBlocks && withinLimits(root, policy),
  );
  return fits ? undefined : ('mdx.merge_limit' satisfies MdxIssueCode);
}

const DEFINITION = new Set(['definition', 'footnoteDefinition']);

function definitionsOf(
  roots: readonly (readonly Entry[])[],
  dialect: Dialect,
  policy: RenderPolicy,
): Definitions | undefined {
  const printed = new Set<string>();
  for (const { node } of roots.flat()) {
    if (!DEFINITION.has(node.type)) continue;
    const text = printAlone(node, dialect);
    if (text === undefined) return undefined;
    printed.add(text);
  }
  if (printed.size === 0) return { text: '', count: 0 };
  const text = [...printed].join('\n\n');
  const parsed = parseForStore(`${text}\n`, dialect, policy);
  return parsed.ok ? { text, count: parsed.value.ast.children.length } : undefined;
}

function once<T>(compute: () => T): () => T {
  let value: { readonly result: T } | undefined;
  return () => {
    value ??= { result: compute() };
    return value.result;
  };
}

const LEADING_BOMS = /^\uFEFF*/;

const INDENTED = /^[ \t]/;

const withGap = (node: MergeNode, source: BlockSource, gapBefore: string) =>
  ({
    ...node,
    source: { ...source, gapBefore, sourceOf: sourceOf(source.rawOf, gapBefore, source.raw) },
  }) as unknown as MdxBlock;

const bomsOf = (gap: string) => LEADING_BOMS.exec(gap)?.[0] ?? '';

// A block that came to the top leaves its gap behind, or the file opens with blank lines. Not a
// rule, though: at the very start of a file its --- would open frontmatter.
function firstBlock({ node, previous }: Entry): MdxBlock {
  const { source } = node;
  if (source === undefined || previous === null || node.type === 'thematicBreak') {
    return node as unknown as MdxBlock;
  }
  return withGap(node, source, bomsOf(source.gapBefore));
}

// Two things were only ever safe beside the block they were written after. A gap with no blank
// line, which opens. And indent, which reads as part of a list above it, or as more of an
// indented code block: those bytes have to go, the one way a merge changes an untouched block.
function placed(items: readonly Entry[], blank: string): readonly MdxBlock[] {
  return items.map((entry, index) => {
    const before = items[index - 1];
    if (before === undefined) return firstBlock(entry);
    const { node, previous } = entry;
    const { source } = node;
    if (source === undefined || before.hash === previous) return node as unknown as MdxBlock;
    if (INDENTED.test(source.raw)) return withoutSource(node) as unknown as MdxBlock;
    if (BLANK_LINE.test(source.gapBefore)) return node as unknown as MdxBlock;
    return withGap(node, source, `${bomsOf(source.gapBefore)}${blank}`);
  });
}

function tailFrom(base: MdxRoot, ours: MdxRoot, theirs: MdxRoot) {
  if (ours.tail === base.tail) return { tail: theirs.tail, tailOf: theirs.tailOf };
  if (theirs.tail === base.tail || ours.tail <= theirs.tail) {
    return { tail: ours.tail, tailOf: ours.tailOf };
  }
  return { tail: theirs.tail, tailOf: theirs.tailOf };
}

const recorded = ({ baseIndex, reason, ours, theirs }: SlotConflict): BlockConflict => ({
  baseIndex,
  reason,
  ours: (ours?.node ?? null) as MdxBlock | null,
  theirs: (theirs?.node ?? null) as MdxBlock | null,
});

const bySlot = (left: BlockConflict, right: BlockConflict) =>
  (left.baseIndex ?? -1) - (right.baseIndex ?? -1);

function mergeRoots(
  base: MdxRoot,
  ours: MdxRoot,
  theirs: MdxRoot,
  entries: readonly [readonly Entry[], readonly Entry[], readonly Entry[]],
  policy: RenderPolicy,
): MergeOutcome {
  const { dialect } = base;
  const context: MergeContext = {
    dialect,
    policy,
    definitions: once(() => definitionsOf(entries, dialect, policy)),
    children: (a, b, c) => mergeChildren(a, b, c, context),
  };
  const [fromBase, fromOurs, fromTheirs] = entries;
  const { items, conflicts } = mergeSequence(fromBase, fromOurs, fromTheirs, context, true);
  const eol = ours.eol === base.eol ? theirs.eol : ours.eol;
  const newline = eol === 'crlf' ? '\r\n' : '\n';
  const tree: MdxRoot = {
    type: 'root',
    astVersion: base.astVersion,
    dialect,
    eol,
    children: placed(items, `${newline}${newline}`),
    ...tailFrom(base, ours, theirs),
  };
  if (conflicts.length > 0) {
    return { kind: 'conflict', partial: tree, conflicts: conflicts.map(recorded).sort(bySlot) };
  }
  // Slot rules find where two sides clash. Whether a result may call itself clean is not theirs to
  // say: content can move in more shapes than they will ever look at, and a word that came back
  // sits in a slot no rule reads. This count does not care how it got there.
  const unexplained = unexplainedTokens(base, ours, theirs, tree);
  if (unexplained === 0) return { kind: 'clean', merged: tree };
  const conflict = {
    baseIndex: null,
    ours: null,
    theirs: null,
    reason: 'unexplained_change',
  } as const;
  return { kind: 'conflict', partial: tree, conflicts: [conflict], unexplained };
}

// Three way merge of untrusted trees, per base slot. Pure, and blocks compare on their own trees,
// never on the hashes they carry. The result has not been printed: send `merged` through
// client.print and store what comes back.
export function merge3(
  base: MdxRoot,
  ours: MdxRoot,
  theirs: MdxRoot,
  options: MergeOptions = {},
): MergeResult {
  const settings = {
    maxBlocks: options.maxBlocks ?? DEFAULT_MERGE_MAX_BLOCKS,
    policy: options.policy ?? FRAGMENT_POLICY,
  };
  const refusal = refusalFor([base, ours, theirs], settings);
  if (refusal !== undefined) return refused(refusal);
  const entries = [base, ours, theirs].map(entriesOfRoot);
  if (entries.includes(undefined)) return refused('mdx.block_not_printable');
  const trio = entries as unknown as readonly [
    readonly Entry[],
    readonly Entry[],
    readonly Entry[],
  ];
  return { ok: true, value: mergeRoots(base, ours, theirs, trio, settings.policy) };
}

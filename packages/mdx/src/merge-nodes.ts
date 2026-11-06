import type { Entry, MergeNode } from './merge-align.ts';
import { mergeSequences } from './merge-diff.ts';
import { parseForStore } from './parse.ts';
import { printCanonical } from './print.ts';
import type { Dialect, MdxBlock, RenderPolicy } from './types.ts';

export interface Definitions {
  readonly text: string;
  readonly count: number;
}

export interface MergeContext {
  readonly dialect: Dialect;
  readonly policy: RenderPolicy;
  // References only resolve beside their definitions, so a lone block parses next to them.
  readonly definitions: () => Definitions | undefined;
  readonly children: (
    base: MergeNode,
    ours: MergeNode,
    theirs: MergeNode,
  ) => readonly MergeNode[] | undefined;
}

// Spaces, single CJK characters, words, then anything else one at a time. Together they rebuild
// the text exactly, so a merge of tokens can only lose what a side deleted.
const TOKEN = /\s+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}_]+|[\s\S]/gu;

export function withoutSource(node: MergeNode): MergeNode {
  const copy: { -readonly [Key in keyof MergeNode]: MergeNode[Key] } = { ...node };
  delete copy.source;
  return copy;
}

// A tree no parser saw can hold anything, so a failure here is a reason to stop and ask.
export function printAlone(node: MergeNode, dialect: Dialect): string | undefined {
  try {
    return printCanonical(node as unknown as MdxBlock, dialect).replace(/\n+$/, '');
  } catch {
    return undefined;
  }
}

function parseAlone(text: string, context: MergeContext): MergeNode | undefined {
  const definitions = context.definitions();
  if (definitions === undefined) return undefined;
  const { text: others, count } = definitions;
  const page = others === '' ? `${text}\n` : `${text}\n\n${others}\n`;
  const parsed = parseForStore(page, context.dialect, context.policy);
  if (!parsed.ok) return undefined;
  const blocks = parsed.value.ast.children as unknown as readonly MergeNode[];
  // A count that moved means this text ate a definition or became two blocks.
  const block = blocks[0];
  return blocks.length === count + 1 && block !== undefined ? withoutSource(block) : undefined;
}

function mergeInline(
  base: MergeNode,
  ours: MergeNode,
  theirs: MergeNode,
  context: MergeContext,
): MergeNode | undefined {
  const asBlock = (node: MergeNode): MergeNode =>
    node.type === 'tableCell' ? { type: 'paragraph', children: node.children ?? [] } : node;
  const texts = [base, ours, theirs].map((node) => printAlone(asBlock(node), context.dialect));
  const [baseText, oursText, theirsText] = texts;
  if (baseText === undefined || oursText === undefined || theirsText === undefined) {
    return undefined;
  }
  const merged = mergeSequences(
    baseText.match(TOKEN) ?? [],
    oursText.match(TOKEN) ?? [],
    theirsText.match(TOKEN) ?? [],
  );
  if (merged === undefined) return undefined;
  const block = parseAlone(merged.join(''), context);
  if (block?.type !== asBlock(base).type) return undefined;
  return base.type === 'tableCell' ? { ...base, children: block.children ?? [] } : block;
}

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

// The fields a block has beyond its children, three way. Undefined when both sides set one
// differently.
function mergeFields(
  base: MergeNode,
  ours: MergeNode,
  theirs: MergeNode,
  fields: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  const merged: Record<string, unknown> = {};
  for (const field of fields) {
    const [was, mine, other] = [base[field], ours[field], theirs[field]];
    if (same(mine, other) || same(other, was)) merged[field] = mine;
    else if (same(mine, was)) merged[field] = other;
    else return undefined;
  }
  return merged;
}

function mergeFieldsAndChildren(
  base: MergeNode,
  ours: MergeNode,
  theirs: MergeNode,
  fields: readonly string[],
  context: MergeContext,
): MergeNode | undefined {
  const merged = mergeFields(base, ours, theirs, fields);
  const children = context.children(base, ours, theirs);
  return merged === undefined || children === undefined
    ? undefined
    : { ...base, ...merged, children };
}

function mergeTable(
  base: MergeNode,
  ours: MergeNode,
  theirs: MergeNode,
  context: MergeContext,
): MergeNode | undefined {
  const merged = mergeFieldsAndChildren(base, ours, theirs, ['align'], context);
  const rows = merged?.children ?? [];
  const width = rows[0]?.children?.length;
  return rows.every(({ children }) => children?.length === width) ? merged : undefined;
}

// One node two sides both changed. Undefined means a person decides.
export function mergeNode(
  base: MergeNode,
  ours: MergeNode,
  theirs: MergeNode,
  context: MergeContext,
): MergeNode | undefined {
  if (base.type !== ours.type || base.type !== theirs.type) return undefined;
  switch (base.type) {
    case 'paragraph':
    case 'tableCell':
      return mergeInline(base, ours, theirs, context);
    case 'heading':
      return mergeFields(base, ours, theirs, ['depth']) === undefined
        ? undefined
        : mergeInline(base, ours, theirs, context);
    case 'list':
      return mergeFieldsAndChildren(base, ours, theirs, ['ordered', 'start', 'spread'], context);
    case 'listItem':
      return mergeFieldsAndChildren(base, ours, theirs, ['checked', 'spread'], context);
    case 'blockquote':
    case 'tableRow':
      return mergeFieldsAndChildren(base, ours, theirs, [], context);
    case 'table':
      return mergeTable(base, ours, theirs, context);
    default:
      return undefined;
  }
}

export const isEmptied = ({ type, children }: MergeNode) =>
  (type === 'list' || type === 'table' || type === 'blockquote') && children?.length === 0;

// What gets stored is what the print parses to, so a merged block takes that shape now. If it
// stops being one block, the merge was not sound and a person decides.
export function settle(node: MergeNode, context: MergeContext): MergeNode | undefined {
  if (isEmptied(node)) return node;
  const text = printAlone(node, context.dialect);
  return text === undefined ? undefined : parseAlone(text, context);
}

// A merged block keeps the base's gap. Its bytes are stale on purpose, which reprints it.
export function mergedEntry(base: Entry, node: MergeNode, hash: string): Entry {
  const { source } = base.node;
  return {
    node: source === undefined ? node : { ...node, source },
    hash,
    previous: base.previous,
  };
}

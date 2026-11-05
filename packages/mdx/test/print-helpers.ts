import { printCanonical } from '../src/print.ts';
import type { MdxBlock, MdxRoot } from '../src/index.ts';

interface Walkable {
  readonly type: string;
  readonly children?: readonly Walkable[];
}

export function withoutSource(block: MdxBlock): MdxBlock {
  const copy = { ...block };
  delete copy.source;
  return copy;
}

// Every block looks new, so each one goes through the printer.
export const allNew = (root: MdxRoot): MdxRoot => ({
  ...root,
  children: root.children.map(withoutSource),
});

export const withChild = (
  root: MdxRoot,
  index: number,
  change: (block: MdxBlock) => MdxBlock,
): MdxRoot => ({
  ...root,
  children: root.children.map((block, at) => (at === index ? change(block) : block)),
});

export const insert = (root: MdxRoot, index: number, block: unknown): MdxRoot => ({
  ...root,
  children: [...root.children.slice(0, index), block as MdxBlock, ...root.children.slice(index)],
});

export const without = (root: MdxRoot, index: number): MdxRoot => ({
  ...root,
  children: root.children.filter((_, at) => at !== index),
});

function definitionsIn(node: Walkable): readonly Walkable[] {
  const own = node.type === 'definition' || node.type === 'footnoteDefinition' ? [node] : [];
  return [...own, ...(node.children ?? []).flatMap(definitionsIn)];
}

// References only resolve beside their definitions, wherever those sit, so a lone block reparses
// next to them.
export const definitionsOf = (root: MdxRoot, except?: MdxBlock): string =>
  root.children
    .flatMap((block) => definitionsIn(block as Walkable))
    .filter((node) => node !== except)
    .map((node) => printCanonical(node as MdxBlock, root.dialect))
    .join('\n\n');

export function changedLines(before: string, after: string): number {
  const old = before.split('\n');
  const next = after.split('\n');
  let start = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start += 1;
  let end = 0;
  while (
    end < old.length - start &&
    end < next.length - start &&
    old[old.length - 1 - end] === next[next.length - 1 - end]
  ) {
    end += 1;
  }
  return Math.max(old.length, next.length) - start - end;
}

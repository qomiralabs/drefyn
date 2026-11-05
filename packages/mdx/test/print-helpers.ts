import type { MdxBlock, MdxRoot } from '../src/index.ts';

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

export const without = (root: MdxRoot, index: number): MdxRoot => ({
  ...root,
  children: root.children.filter((_, at) => at !== index),
});

// References only resolve beside their definitions, so a lone block reparses next to them.
export const definitionsOf = (root: MdxRoot): string =>
  root.children
    .filter((block) => block.type === 'definition' || block.type === 'footnoteDefinition')
    .map((block) => block.source?.raw ?? '')
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

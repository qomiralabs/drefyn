import { MdxPrintError } from './print.ts';
import type { MdxBlock, MdxLimits } from './types.ts';

interface Walked {
  readonly children?: readonly Walked[];
  readonly attributes?: readonly unknown[];
  readonly [key: string]: unknown;
}

interface Frame {
  readonly node: Walked;
  readonly depth: number;
  readonly block: number;
}

// Where a tree holds nothing that prints, or holds what is walked on its own.
const SKIPPED = new Set(['children', 'attributes', 'source', 'position', 'data', 'type']);

const INDENT_BYTES = 2;

function textBytes(values: Readonly<Record<string, unknown>>, depth: number): number {
  let bytes = 0;
  for (const [key, value] of Object.entries(values)) {
    if (SKIPPED.has(key)) continue;
    if (typeof value === 'object' && value !== null) {
      bytes += textBytes(value as Readonly<Record<string, unknown>>, depth);
    } else if (typeof value === 'string') {
      bytes += Buffer.byteLength(value, 'utf8');
      // Every line of a value takes the indent of all its containers, so output is text times
      // depth: 1 MiB at depth 64 printed 68 MB.
      for (let at = value.indexOf('\n'); at !== -1; at = value.indexOf('\n', at + 1)) {
        bytes += depth * INDENT_BYTES;
      }
    }
  }
  return bytes;
}

// The same limits a parse has, as a tree can come from anywhere. Runs before anything recursive
// touches it, so it keeps its own stack. Depth counts from the top level blocks at 1. This only
// makes refusals cheap: the bound on printing is the kill in the host.
export function checkTree(children: readonly MdxBlock[], limits: MdxLimits): void {
  const stack: Frame[] = [];
  for (const [block, node] of (children as unknown as readonly Walked[]).entries()) {
    stack.push({ node, depth: 1, block });
  }
  let nodes = 0;
  let bytes = 0;
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    const { node, depth, block } = frame;
    const attributes = node.attributes ?? [];
    nodes += 1 + attributes.length;
    bytes += textBytes(node, depth);
    for (const attribute of attributes) {
      bytes += textBytes(attribute as Readonly<Record<string, unknown>>, depth);
    }
    if (depth > limits.maxDepth || nodes > limits.maxNodes || bytes > limits.maxBytes) {
      throw new MdxPrintError(block);
    }
    for (const child of node.children ?? []) stack.push({ node: child, depth: depth + 1, block });
  }
}

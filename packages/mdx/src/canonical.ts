import { createHash } from 'node:crypto';
import type { MdastBlock, MdxBlock } from './types.ts';

// Neither says anything about content, and position changes whenever a block above moves.
// Stored trees carry no data, so its presence is reported instead of hashed: see digest.
const isIgnored = (key: string) => key === 'position' || key === 'data' || key === 'source';

interface Seen {
  data: boolean;
}

export const foldLineEndings = (text: string) =>
  text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;

// CommonMark renders a line ending in a code span as a space, so both are one value.
export const spanValue = (text: string) => foldLineEndings(text).replaceAll('\n', ' ');

// This runs on every block twice per round trip, so it builds one string and skips the arrays
// a generic walker would allocate.
function canonical(value: unknown, seen: Seen): string {
  if (typeof value === 'string') return JSON.stringify(foldLineEndings(value));
  if (typeof value !== 'object' || value === null) return String(value);
  if (Array.isArray(value)) {
    let items = '[';
    for (const item of value) items += `${canonical(item, seen)},`;
    return `${items}]`;
  }
  const node = value as Readonly<Record<string, unknown>>;
  let fields = '{';
  for (const key of Object.keys(node).sort()) {
    const field = node[key];
    if (field === null || field === undefined) continue;
    if (key === 'data') seen.data = true;
    if (isIgnored(key)) continue;
    const text =
      node['type'] === 'inlineCode' && key === 'value' && typeof field === 'string'
        ? JSON.stringify(spanValue(field))
        : canonical(field, seen);
    fields += `${JSON.stringify(key)}:${text},`;
  }
  return `${fields}}`;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export interface Digest {
  readonly rawOf: string;
  // False when `data` sits anywhere in the tree. Renderers honour it, git never sees it.
  readonly plain: boolean;
}

export function digest(block: MdxBlock | MdastBlock): Digest {
  const seen: Seen = { data: false };
  return { rawOf: sha256(canonical(block, seen)), plain: !seen.data };
}

// The hash of what a block means, not how it was written, so a reformat is not an edit.
export const rawOf = (block: MdxBlock | MdastBlock): string => digest(block).rawOf;

// Binds the bytes that get printed to the tree they came from. Lengths keep a byte from moving
// between the gap and the block unseen. Unkeyed: it catches stale bytes, and anyone who can
// write the row can also recompute it.
export const sourceOf = (tree: string, gapBefore: string, raw: string): string =>
  sha256(`${tree}:${gapBefore.length}:${gapBefore}${raw}`);

export const tailOf = (tail: string): string => sha256(tail);

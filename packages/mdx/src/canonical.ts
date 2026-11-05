import { createHash } from 'node:crypto';
import type { MdastBlock, MdxBlock } from './types.ts';

// None says anything about content, and position changes whenever a block above moves.
const isIgnored = (key: string) => key === 'position' || key === 'data' || key === 'source';

const foldLineEndings = (text: string) =>
  text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;

// This runs on every block twice per round trip, so it builds one string and skips the arrays
// a generic walker would allocate.
function canonical(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(foldLineEndings(value));
  if (typeof value !== 'object' || value === null) return String(value);
  if (Array.isArray(value)) {
    let items = '[';
    for (const item of value) items += `${canonical(item)},`;
    return `${items}]`;
  }
  const node = value as Readonly<Record<string, unknown>>;
  let fields = '{';
  for (const key of Object.keys(node).sort()) {
    const field = node[key];
    if (field === null || field === undefined || isIgnored(key)) continue;
    // CommonMark renders a line ending in a code span as a space, so both are one value.
    const text =
      node['type'] === 'inlineCode' && key === 'value' && typeof field === 'string'
        ? JSON.stringify(foldLineEndings(field).replaceAll('\n', ' '))
        : canonical(field);
    fields += `${JSON.stringify(key)}:${text},`;
  }
  return `${fields}}`;
}

// The hash of what a block means, not how it was written, so a reformat is not an edit.
export function rawOf(block: MdxBlock | MdastBlock): string {
  return createHash('sha256').update(canonical(block)).digest('hex');
}

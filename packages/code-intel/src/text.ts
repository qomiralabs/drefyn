import type { Node } from 'web-tree-sitter';

// One line, single spaces, no padding inside brackets, and no trailing comma a formatter added
// when it broke the list over lines. A reformat must not read as a signature change.
export function normalizeSignature(text: string): string {
  return text
    .replace(/,\s*\n\s*([)\]}>])/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/([([]) /g, '$1')
    .replace(/ ([)\]])/g, '$1')
    .replace(/[\s;:,={]+$/, '')
    .trim();
}

// Source of a declaration up to where its body starts, so a body edit is not a signature change.
export function head(node: Node, end: Node | null | undefined, from: Node = node): string {
  const text = node.text;
  const start = from.startIndex - node.startIndex;
  const stop = end === null || end === undefined ? text.length : end.startIndex - node.startIndex;
  return normalizeSignature(text.slice(start, stop));
}

// The row of the last character, since a line comment's node ends after its newline.
export function lastRow(node: Node): number {
  const end = node.endPosition;
  return end.column === 0 && end.row > node.startPosition.row ? end.row - 1 : end.row;
}

// A comment directly above, with no blank line, that does not trail other code on its line.
export function isAttached(comment: Node, below: Node): boolean {
  if (lastRow(comment) < below.startPosition.row - 1) return false;
  const before = comment.previousSibling;
  return before === null || lastRow(before) < comment.startPosition.row;
}

function trimBlank(lines: readonly string[]): string | null {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === '') start += 1;
  while (end > start && lines[end - 1]?.trim() === '') end -= 1;
  const text = lines.slice(start, end).join('\n');
  return text === '' ? null : text;
}

// `/** ... */` without its frame and the leading star of each line.
export function blockDoc(text: string): string | null {
  const inner = text.replace(/^\/\*\*/, '').replace(/\*\/$/, '');
  const lines = inner.split(/\r?\n/).map((line, index) => {
    const bare = line.replace(/^\s*\* ?/, '');
    return (index === 0 ? bare.trimStart() : bare).trimEnd();
  });
  return trimBlank(lines.length === 1 ? lines.map((line) => line.trim()) : lines);
}

// Consecutive `//` or `///` lines without the marker and the one space after it.
export function lineDoc(lines: readonly string[], marker: string): string | null {
  return trimBlank(lines.map((line) => line.trimEnd().slice(marker.length).replace(/^ /, '')));
}

// A Python docstring the way inspect.cleandoc reads it.
export function docstring(text: string): string | null {
  const match = /^([rRuU]?)("""|'''|"|')([\s\S]*)\2$/.exec(text);
  const body = match?.[3];
  if (body === undefined) return null;
  const lines = body.split(/\r?\n/);
  const rest = lines.slice(1);
  const indents = rest
    .filter((line) => line.trim() !== '')
    .map((line) => line.length - line.trimStart().length);
  const indent = indents.length === 0 ? 0 : Math.min(...indents);
  return trimBlank([(lines[0] ?? '').trim(), ...rest.map((line) => line.slice(indent).trimEnd())]);
}

// The text of a string literal with no interpolation, or undefined when it is computed.
export function literalText(node: Node | null | undefined): string | undefined {
  if (node === null || node === undefined) return undefined;
  switch (node.type) {
    case 'string':
    case 'template_string': {
      if (node.namedChildren.some((child) => child.type === 'template_substitution'))
        return undefined;
      if (node.namedChildren.some((child) => child.type === 'interpolation')) return undefined;
      const text = node.text;
      const quote = /^[a-zA-Z]*("""|'''|"|'|`)/.exec(text);
      if (quote?.[1] === undefined) return undefined;
      const prefix = quote[0].length;
      if (/[fF]/.test(quote[0])) return undefined;
      return text.slice(prefix, text.length - quote[1].length);
    }
    case 'interpreted_string_literal':
    case 'string_literal':
      return node.text.slice(1, -1);
    case 'raw_string_literal': {
      // Go writes these in backticks, Rust as r"..." or r#"..."#.
      const rust = /^r(#*)"([\s\S]*)"\1$/.exec(node.text);
      return rust === null ? node.text.slice(1, -1) : rust[2];
    }
    default:
      return undefined;
  }
}

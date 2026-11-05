import { foldLineEndings } from './canonical.ts';
import type { MdxBlock } from './types.ts';

interface Shaped {
  readonly type: string;
  readonly children?: readonly Shaped[];
  readonly value?: unknown;
  readonly name?: unknown;
  readonly lang?: unknown;
  readonly meta?: unknown;
  readonly depth?: unknown;
  readonly attributes?: readonly { readonly name?: unknown; readonly value?: unknown }[];
}

// Text inside a block can settle differently with no harm: a URL becomes a link, trailing space
// goes, neighbouring text joins. So these say nothing, though what sits inside them still does.
const PLAIN = new Set([
  'break',
  'delete',
  'emphasis',
  'footnoteReference',
  'image',
  'imageReference',
  'inlineCode',
  'link',
  'linkReference',
  'strong',
  'text',
]);

const folded = (value: unknown) =>
  typeof value === 'string' ? foldLineEndings(value) : (value ?? null);

// A footnote printing a code block blanks lines of only whitespace, which means nothing.
const codeValue = (value: unknown) =>
  typeof value === 'string' ? foldLineEndings(value).replace(/^[ \t]+$/gm, '') : value;

function attributeValue(value: unknown): unknown {
  return typeof value === 'object' && value !== null
    ? folded((value as { readonly value?: unknown }).value)
    : folded(value);
}

function detail(node: Shaped): unknown {
  switch (node.type) {
    case 'code':
      return [codeValue(node.value), folded(node.lang), folded(node.meta)];
    case 'heading':
      return node.depth;
    case 'mdxJsxFlowElement':
    case 'mdxJsxTextElement':
      return [
        node.name ?? null,
        (node.attributes ?? []).map(({ name, value }) => [name ?? null, attributeValue(value)]),
      ];
    default:
      return folded(node.value);
  }
}

function shape(node: Shaped): string {
  const inner = (node.children ?? []).map(shape).join('');
  if (PLAIN.has(node.type)) return inner;
  // Editors leave these behind, and they print as nothing.
  if (node.type === 'paragraph' && node.children?.length === 0) return '';
  return `(${JSON.stringify([node.type, detail(node)])}${inner})`;
}

// Every block and every live node, in order, with what it holds. Hashes are too strict for a
// tree no parser saw, and this is what a reader or a renderer would act on.
export const meaningOf = (children: readonly MdxBlock[]): string =>
  (children as unknown as readonly Shaped[]).map(shape).join('');

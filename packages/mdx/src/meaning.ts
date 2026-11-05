import { foldLineEndings, rawOf } from './canonical.ts';
import type { MdxBlock } from './types.ts';

interface Shaped {
  readonly type: string;
  readonly children?: readonly Shaped[];
  readonly value?: unknown;
  readonly name?: unknown;
  readonly lang?: unknown;
  readonly meta?: unknown;
  readonly depth?: unknown;
  readonly alt?: unknown;
  readonly url?: unknown;
  readonly identifier?: unknown;
  readonly ordered?: unknown;
  readonly start?: unknown;
  readonly align?: readonly unknown[] | null;
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

// A parser folds these, so a tree written by hand can differ in case alone.
const nameOf = ({ identifier }: Shaped) =>
  typeof identifier === 'string' ? identifier.toLowerCase() : null;

function detail(node: Shaped): unknown {
  switch (node.type) {
    case 'code':
      return [codeValue(node.value), folded(node.lang), folded(node.meta)];
    case 'heading':
      return node.depth;
    case 'definition':
      return [nameOf(node), folded(node.url)];
    case 'footnoteDefinition':
      return nameOf(node);
    case 'list':
      return node.ordered === true ? (node.start ?? 1) : null;
    case 'table':
      // No alignment and a run of nulls are one thing, and a parser only writes the second.
      return (node.align ?? []).join(',').replace(/,+$/, '');
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

const isEmpty = ({ type, children }: Shaped) => type === 'paragraph' && children?.length === 0;

function shape(node: Shaped): string {
  const inner = (node.children ?? []).map(shape).join('');
  if (PLAIN.has(node.type)) return inner;
  // Editors leave these behind, and they print as nothing.
  if (isEmpty(node)) return '';
  return `(${JSON.stringify([node.type, detail(node)])}${inner})`;
}

// Every block and every live node, in order, with what it holds. Hashes are too strict for a
// tree no parser saw, and this is what a reader or a renderer would act on.
export const meaningOf = (children: readonly MdxBlock[]): string =>
  (children as unknown as readonly Shaped[]).map(shape).join('');

const REFERENCES = new Set(['footnoteReference', 'imageReference', 'linkReference']);

const hasReference = (node: Shaped): boolean =>
  REFERENCES.has(node.type) || (node.children ?? []).some(hasReference);

// What a reader sees, without what a reference is written in.
function visibleText(node: Shaped): string {
  const own = [node.value, node.alt].filter((text) => typeof text === 'string').join('');
  const inner = (node.children ?? []).map(visibleText).join('');
  return `${own}${inner}`.replace(/[![\]\\]/g, '');
}

// A definition elsewhere on the page decides whether [a] is a reference or text, so an edit
// beside a block can change its tree and nothing else. Nothing the tree said may be lost.
const saysTheSame = (block: Shaped, again: Shaped) =>
  visibleText(again).includes(visibleText(block));

function holds(block: Shaped, again: Shaped | undefined): boolean {
  if (again === undefined) return false;
  if (rawOf(block as unknown as MdxBlock) === rawOf(again as unknown as MdxBlock)) return true;
  return (hasReference(block) || hasReference(again)) && saysTheSame(block, again);
}

// The looser check above lets text settle, which only a printed block can need. A block printed
// from stored bytes claims to be exactly its tree, so here a change is forged bytes.
export function keptItsBytes(
  children: readonly MdxBlock[],
  reparsed: readonly MdxBlock[],
): boolean {
  const kept = (children as unknown as readonly (Shaped & Pick<MdxBlock, 'source'>)[]).filter(
    (block) => !isEmpty(block),
  );
  const again = reparsed as unknown as readonly Shaped[];
  return kept.every(
    (block, index) =>
      block.source?.rawOf !== rawOf(block as unknown as MdxBlock) || holds(block, again[index]),
  );
}

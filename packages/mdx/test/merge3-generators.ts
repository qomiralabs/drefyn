import fc from 'fast-check';
import { printCanonical } from '../src/print.ts';
import type { Dialect, MdxBlock, MdxRoot } from '../src/index.ts';
import { loadCorpus, parsed } from './helpers.ts';

// Everything a generated page can be edited with. Each edit carries unique tokens, so a test can
// follow a word from either side into the merge and say exactly where it went.
export interface Edit {
  readonly kind:
    | 'append'
    | 'prepend'
    | 'insert'
    | 'delete'
    | 'move'
    | 'addItem'
    | 'deleteItem'
    | 'addRow'
    | 'deleteRow'
    | 'reformat'
    | 'retype'
    | 'split'
    | 'join'
    | 'pullOut';
  readonly at: number;
  readonly choice: number;
}

export interface MergeCase {
  readonly page: { readonly corpus: number } | { readonly seed: number };
  readonly crlf: boolean;
  readonly ours: readonly Edit[];
  readonly theirs: readonly Edit[];
}

export interface Tree {
  readonly type: string;
  children?: Tree[];
  value?: string;
  source?: unknown;
  spread?: boolean;
  checked?: boolean | null;
}

interface SideBlock {
  node: Tree;
  raw: string;
  gap: string;
}

export interface Side {
  readonly text: string;
  // Tokens in blocks this side moved. Order against them follows the mover, not the other side.
  readonly moved: ReadonlySet<string>;
  // Tokens in a paragraph this side split. One token alone cannot show that it happened.
  readonly split: ReadonlySet<string>;
}

const asBlock = (node: Tree) => node as unknown as MdxBlock;
const LEAF = new Set(['paragraph', 'heading', 'tableCell']);
const TOKEN = /\b(?:u\d+|[OT]\d+)\b/g;

const tagged = (dialect: Dialect, tree: Tree, next: () => string): void => {
  if (LEAF.has(tree.type)) {
    const lead = (tree.children?.length ?? 0) > 0 ? ' ' : '';
    tree.children = [...(tree.children ?? []), { type: 'text', value: `${lead}${next()}` }];
  } else if (tree.type === 'code') {
    tree.value = `${tree.value === undefined || tree.value === '' ? '' : `${tree.value}\n`}${next()}`;
  } else if (!tree.type.startsWith('mdx')) {
    for (const child of tree.children ?? []) tagged(dialect, child, next);
  }
};

const printed = (node: Tree, dialect: Dialect) =>
  printCanonical(asBlock(node), dialect).replace(/\n+$/, '');

const withoutSource = (node: Tree): Tree => {
  const copy = { ...node };
  delete copy.source;
  return copy;
};

const TAGGABLE = new Set(['paragraph', 'heading', 'list', 'blockquote', 'table', 'code']);
const KEPT = new Set([...TAGGABLE, 'yaml', 'thematicBreak']);
const MIN_BLOCKS = 4;
const MAX_BLOCKS = 40;

function tagPage(root: MdxRoot, dialect: Dialect): string | undefined {
  let unique = 0;
  const next = () => {
    unique += 1;
    return `u${unique}`;
  };
  try {
    const kept = (root.children as unknown as readonly Tree[]).filter(({ type }) => KEPT.has(type));
    const blocks = kept.map((block) => {
      const copy = structuredClone(withoutSource(block));
      tagged(dialect, copy, next);
      return printed(copy, dialect);
    });
    return `${blocks.join('\n\n')}\n`;
  } catch {
    return undefined;
  }
}

export interface TaggedPage {
  readonly text: string;
  readonly dialect: Dialect;
}

// Real pages, cut to a size a generated edit can land on, with a unique word in every leaf.
export function corpusPages(limit: number): readonly TaggedPage[] {
  const pages: TaggedPage[] = [];
  const files = loadCorpus().filter(({ bytes }) => bytes.length > 600 && bytes.length < 6_000);
  for (const { text, dialect } of files.slice(0, limit)) {
    try {
      const tagged = tagPage(parsed(text, dialect), dialect);
      if (tagged === undefined) continue;
      const { length } = parsed(tagged, dialect).children;
      if (length >= MIN_BLOCKS && length <= MAX_BLOCKS) pages.push({ text: tagged, dialect });
    } catch {
      // The corpus holds pages the tagging turns invalid, and those prove nothing here.
    }
  }
  return pages;
}

// Blocks that sit tight, lists that only differ by marker and nested structure: the places where
// a merge can break what printing a block on its own could not.
export function generatedPage(seed: number): string {
  let state = seed >>> 0;
  const pick = (range: number) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return (state >>> 16) % range;
  };
  let unique = 0;
  const word = () => {
    unique += 1;
    return `u${unique}`;
  };
  const sentence = () => `word ${word()} more ${pick(2) === 0 ? '**bold** ' : ''}text ${word()}`;
  const list = () => {
    const marker = ['-', '*', '+', '1.'][pick(4)] ?? '-';
    const indent = ' '.repeat(marker.length + 1);
    return Array.from({ length: 2 + pick(4) }, () => {
      const nested =
        pick(4) === 0 ? `\n${indent}- nested ${word()}\n${indent}- nested ${word()}` : '';
      return `${marker} ${sentence()}${nested}`;
    }).join('\n');
  };
  const table = () => {
    const columns = 2 + pick(3);
    const row = () => `| ${Array.from({ length: columns }, () => `c ${word()}`).join(' | ')} |`;
    const rule = `| ${Array.from({ length: columns }, () => '---').join(' | ')} |`;
    return [row(), rule, ...Array.from({ length: 2 + pick(3) }, row)].join('\n');
  };
  const blocks: string[] = [];
  const count = 4 + pick(9);
  for (let index = 0; index < count; index += 1) {
    const kind = pick(8);
    if (kind === 0) blocks.push(`${'#'.repeat(1 + pick(3))} Title ${word()}`);
    else if (kind === 1) blocks.push(list());
    else if (kind === 2) blocks.push(table());
    else if (kind === 3) blocks.push(`\`\`\`js\nconst a = 1\n${word()}\n\`\`\``);
    else if (kind === 4) blocks.push(`> quote ${word()}\n>\n> ${sentence()}`);
    else if (kind === 5) blocks.push(`    indented ${word()}`);
    else blocks.push(sentence());
  }
  // A tight join is kept only where a heading or a fence ends itself, so these stay honest pages.
  return `${blocks
    .map((block, index) => {
      const previous = blocks[index - 1];
      if (previous === undefined) return block;
      return previous.startsWith('#') && !block.startsWith('    ') && pick(2) === 0
        ? `\n${block}`
        : `\n\n${block}`;
    })
    .join('')}\n`;
}

const leavesOf = (node: Tree): readonly Tree[] => {
  if (LEAF.has(node.type)) return [node];
  if (node.type.startsWith('mdx')) return [];
  return (node.children ?? []).flatMap(leavesOf);
};

const listsIn = (node: Tree): readonly Tree[] => [
  ...(node.type === 'list' ? [node] : []),
  ...(node.children ?? []).flatMap(listsIn),
];

const tokensOf = (node: Tree) => JSON.stringify(node).match(TOKEN) ?? [];

// With a space each side, so it is never part of a URL, where one word prints twice.
const PLAIN_WORD = /(?<= )(?!u\d)[a-z]{3,}(?= )/;

// Changes what a block is and one of its words together, which reads as a delete and an insert.
// Its unique tokens stay, so a test can see whether a delete of it was honoured.
export function retyped(raw: string, word: string, choice: number): string {
  const changed = PLAIN_WORD.test(raw) ? raw.replace(PLAIN_WORD, word) : `${raw} ${word}`;
  const lines = changed.split('\n');
  const quoted = lines.map((line) => `> ${line}`).join('\n');
  if (lines.length > 1 || choice % 3 === 0) return quoted;
  return choice % 3 === 1 ? `## ${changed}` : `- ${changed}`;
}

const SIDE_BLOCKS = (word: string) => [
  `para ${word}`,
  `## heading ${word}`,
  `\`\`\`\ncode ${word}\n\`\`\``,
  `> quoted ${word}`,
];

// A block from text, or nothing if the text does not stay one block.
function parts(raw: string, dialect: Dialect): SideBlock | undefined {
  const [node, extra] = parsed(`${raw}\n`, dialect).children as unknown as readonly Tree[];
  if (node === undefined || extra !== undefined) return undefined;
  return { raw, gap: '\n\n', node: withoutSource(node) };
}

// Applies a script through the tree and the printer, the way an editor change would.
export function applyEdits(
  text: string,
  dialect: Dialect,
  edits: readonly Edit[],
  letter: 'O' | 'T',
): Side {
  const root = parsed(text, dialect);
  const blocks: SideBlock[] = (root.children as unknown as readonly Tree[]).map((node) => {
    const source = node.source as { readonly raw: string; readonly gapBefore: string };
    return { node: structuredClone(withoutSource(node)), raw: source.raw, gap: source.gapBefore };
  });
  const moved = new Set<string>();
  const split = new Set<string>();
  let count = 0;
  const token = () => {
    count += 1;
    return `${letter}${count}`;
  };
  const reprint = (block: SideBlock) => {
    block.raw = printed(block.node, dialect);
    block.node = withoutSource(
      (parsed(`${block.raw}\n`, dialect).children[0] ?? asBlock(block.node)) as unknown as Tree,
    );
  };
  for (const { kind, at, choice } of edits) {
    const index = blocks.length > 0 ? at % blocks.length : 0;
    const block = blocks[index];
    if (kind === 'insert') {
      const options = SIDE_BLOCKS(token());
      const raw = options[choice % options.length] ?? '';
      const node = withoutSource(parsed(`${raw}\n`, dialect).children[0] as unknown as Tree);
      blocks.splice(index + (choice % 2), 0, { raw, gap: '\n\n', node });
      continue;
    }
    if (block === undefined) continue;
    if (kind === 'append' || kind === 'prepend') {
      const leaves = leavesOf(block.node);
      const leaf = leaves[choice % Math.max(leaves.length, 1)];
      if (leaf === undefined) continue;
      const word = token();
      const added = { type: 'text', value: kind === 'append' ? ` ${word}` : `${word} ` };
      leaf.children =
        kind === 'append' ? [...(leaf.children ?? []), added] : [added, ...(leaf.children ?? [])];
      reprint(block);
    } else if (kind === 'delete') {
      if (blocks.length > 2 && block.node.type !== 'yaml') blocks.splice(index, 1);
    } else if (kind === 'move') {
      if (block.node.type === 'yaml' || blocks.length < 3) continue;
      blocks.splice(index, 1);
      let target = choice % (blocks.length + 1);
      if (blocks[0]?.node.type === 'yaml' && target === 0) target = 1;
      blocks.splice(target, 0, block);
      block.gap = '\n\n';
      for (const word of tokensOf(block.node)) moved.add(word);
    } else if (kind === 'addItem' || kind === 'deleteItem') {
      const lists = listsIn(block.node);
      const list = lists[choice % Math.max(lists.length, 1)];
      const items = list?.children;
      if (items === undefined) continue;
      if (kind === 'addItem') {
        const text = { type: 'text', value: `item ${token()}` };
        const paragraph = { type: 'paragraph', children: [text] };
        const item = { type: 'listItem', spread: false, checked: null, children: [paragraph] };
        items.splice(choice % (items.length + 1), 0, item);
      } else if (items.length > 1) items.splice(choice % items.length, 1);
      reprint(block);
    } else if (kind === 'addRow' || kind === 'deleteRow') {
      const rows = block.node.type === 'table' ? block.node.children : undefined;
      if (rows === undefined) continue;
      if (kind === 'addRow') {
        const cells = (rows[0]?.children ?? []).map(() => ({
          type: 'tableCell',
          children: [{ type: 'text', value: `cell ${token()}` }],
        }));
        rows.splice(1 + (choice % rows.length), 0, { type: 'tableRow', children: cells });
      } else {
        if (rows.length < 3) continue;
        rows.splice(1 + (choice % (rows.length - 1)), 1);
      }
      reprint(block);
    } else if (kind === 'split') {
      const words = block.raw.split(' ');
      if (block.node.type !== 'paragraph' || words.length < 4 || block.raw.includes('\n')) continue;
      const cut = 1 + (choice % (words.length - 1));
      const first = parts(words.slice(0, cut).join(' '), dialect);
      const second = parts(words.slice(cut).join(' '), dialect);
      if (first === undefined || second === undefined) continue;
      for (const word of tokensOf(block.node)) split.add(word);
      blocks.splice(index, 1, first, second);
    } else if (kind === 'join') {
      const next = blocks[index + 1];
      if (block.node.type !== 'paragraph' || next?.node.type !== 'paragraph') continue;
      const whole = parts(`${block.raw} ${next.raw}`, dialect);
      if (whole === undefined) continue;
      blocks.splice(index, 2, { ...whole, gap: block.gap });
    } else if (kind === 'pullOut') {
      const items = block.node.type === 'list' ? block.node.children : undefined;
      const item = items?.at(-1)?.children?.[0];
      if (items === undefined || items.length < 2 || item?.type !== 'paragraph') continue;
      const out = parts(`> ${printed(item, dialect)}`, dialect);
      if (out === undefined) continue;
      for (const word of tokensOf(item)) moved.add(word);
      items.pop();
      reprint(block);
      blocks.splice(index + 1, 0, out);
    } else if (kind === 'retype') {
      if (block.node.type === 'yaml') continue;
      block.raw = retyped(block.raw, token(), choice);
      const [node] = parsed(`${block.raw}\n`, dialect).children as unknown as readonly Tree[];
      if (node !== undefined) block.node = withoutSource(node);
    } else if (block.node.type === 'heading' && /^#+ /.test(block.raw) && !/ #+$/.test(block.raw)) {
      block.raw += ' #';
    } else if (block.node.type === 'list') {
      block.raw = block.raw.replace(/^(\s*)- /gm, '$1* ');
    }
  }
  const lines = blocks.map(({ gap, raw }, index) => {
    if (index === 0) return raw;
    return `${/\n[ \t]*\n/.test(gap) ? gap : '\n\n'}${raw}`;
  });
  return { text: `${lines.join('')}\n`, moved, split };
}

const editArbitrary: fc.Arbitrary<Edit> = fc.record({
  kind: fc.constantFrom<Edit['kind']>(
    'append',
    'append',
    'prepend',
    'insert',
    'delete',
    'move',
    'addItem',
    'deleteItem',
    'addRow',
    'deleteRow',
    'reformat',
    'retype',
    'split',
    'join',
    'pullOut',
  ),
  at: fc.nat(1_000_000),
  choice: fc.nat(1_000_000),
});

export const mergeCaseArbitrary = (pages: number): fc.Arbitrary<MergeCase> =>
  fc.record({
    page: fc.oneof(
      fc.nat(pages - 1).map((corpus) => ({ corpus })),
      fc.integer({ min: 1, max: 2_000_000_000 }).map((seed) => ({ seed })),
    ),
    crlf: fc.boolean(),
    ours: fc.array(editArbitrary, { minLength: 1, maxLength: 4 }),
    theirs: fc.array(editArbitrary, { minLength: 1, maxLength: 4 }),
  });

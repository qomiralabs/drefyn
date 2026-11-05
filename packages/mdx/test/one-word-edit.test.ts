import { describe, expect, it } from 'vitest';
import { printCanonical, rawOf, serialize } from '../src/index.ts';
import type { MdxBlock, MdxRoot } from '../src/index.ts';
import { loadCorpus, parsed } from './helpers.ts';
import { changedLines, withChild } from './print-helpers.ts';

const TIMEOUT_MS = 180_000;
const WORD = /[A-Za-z]{4,}/;
const REPLACEMENT = 'zebra';

interface Target {
  readonly index: number;
  readonly edited: MdxBlock;
}

// The first plain text word in the block, the way a person edits one word in the editor.
function editWord(node: unknown): unknown {
  const { type, value, children } = node as { type: string; value?: string; children?: unknown[] };
  if (type === 'text' && value !== undefined && WORD.test(value)) {
    return { ...(node as object), value: value.replace(WORD, REPLACEMENT) };
  }
  if (type === 'mdxJsxFlowElement' || type === 'mdxJsxTextElement' || children === undefined) {
    return undefined;
  }
  for (const [at, child] of children.entries()) {
    const edited = editWord(child);
    if (edited !== undefined) {
      return { ...(node as object), children: children.with(at, edited) };
    }
  }
  return undefined;
}

function targetIn(root: MdxRoot, wanted: (block: MdxBlock) => boolean): Target | undefined {
  for (const [index, block] of root.children.entries()) {
    if (!wanted(block)) continue;
    const edited = editWord(block) as MdxBlock | undefined;
    if (edited !== undefined) return { index, edited };
  }
  return undefined;
}

// Reprinting is whole block, so an edit can only be one line once the block already prints
// the way it was written. Blocks written another way change more; see the bound below.
const isCanonical = (block: MdxBlock, dialect: MdxRoot['dialect']) =>
  block.source !== undefined && printCanonical(block, dialect) === block.source.raw;

const corpus = loadCorpus();

describe('a one word edit', () => {
  it(
    'changes one line in a block that is already canonical',
    () => {
      let pages = 0;
      for (const { file, text, dialect } of corpus) {
        const root = parsed(text, dialect);
        const target = targetIn(root, (block) => isCanonical(block, dialect));
        if (target === undefined) continue;
        pages += 1;
        const output = serialize(withChild(root, target.index, () => target.edited));
        expect(changedLines(text, output), file).toBe(1);
      }
      expect(pages).toBeGreaterThan(150);
    },
    TIMEOUT_MS,
  );

  it(
    'never reaches past the block it edited',
    () => {
      for (const { file, text, dialect } of corpus) {
        const root = parsed(text, dialect);
        const target = targetIn(root, () => true);
        if (target === undefined) continue;
        const before = root.children[target.index];
        const output = serialize(withChild(root, target.index, () => target.edited));
        const lines = before?.source?.raw.split('\n').length ?? 0;
        // A blank line can open beside the block, which adds one on each side at most.
        expect(changedLines(text, output), file).toBeLessThanOrEqual(lines + 2);
        const reparsed = parsed(output, dialect).children.map(rawOf);
        const expected = root.children.map((block, index) =>
          rawOf(index === target.index ? target.edited : block),
        );
        expect(reparsed, file).toEqual(expected);
      }
    },
    TIMEOUT_MS,
  );
});

import type { Nodes as HastNodes } from 'hast';
import { toHtml } from 'hast-util-to-html';
import type { Root } from 'mdast';
import { toHast } from 'mdast-util-to-hast';
import { describe, expect, it } from 'vitest';
import { serialize } from '../src/serialize.ts';
import type { Dialect, MdxBlock, MdxRoot } from '../src/index.ts';
import { loadCorpus, parsed } from './helpers.ts';
import { allNew } from './print-helpers.ts';

const TIMEOUT_MS = 180_000;

// Every MDX node stays visible, so a difference in one cannot hide behind the renderer
// skipping a kind it does not know.
function literal(_state: unknown, node: { type: string; value?: string; name?: string | null }) {
  return { type: 'text', value: `${node.type}:${node.name ?? ''}:${node.value ?? ''}` } as const;
}

const render = (children: readonly MdxBlock[]): string => {
  const tree = { type: 'root', children: children.map(strip) } as unknown as Root;
  const hast: HastNodes = toHast(tree, {
    allowDangerousHtml: true,
    unknownHandler: literal,
  });
  return toHtml(hast, { allowDangerousHtml: true }).replaceAll('\r\n', '\n');
};

const strip = (block: MdxBlock) => {
  const copy = { ...block };
  delete copy.source;
  return copy;
};

function expectSameRender(file: string, stored: MdxRoot, printed: string, dialect: Dialect) {
  expect(render(parsed(printed, dialect).children), file).toBe(render(stored.children));
}

describe('rendering', () => {
  it(
    'from reparsed raw equals rendering from the stored tree',
    () => {
      for (const { file, text, dialect } of loadCorpus()) {
        const stored = parsed(text, dialect);
        expectSameRender(file, stored, serialize(stored), dialect);
      }
    },
    TIMEOUT_MS,
  );

  it(
    'from reparsed canonical output equals rendering from the stored tree',
    () => {
      for (const { file, text, dialect } of loadCorpus()) {
        const stored = parsed(text, dialect);
        expectSameRender(file, stored, serialize(allNew(stored)), dialect);
      }
    },
    TIMEOUT_MS,
  );

  it('sees a difference when there is one', () => {
    const one = parsed('one\n', 'md');
    const two = parsed('two\n', 'md');
    expect(render(one.children)).not.toBe(render(two.children));
    expect(render(parsed('{a}\n', 'mdx').children)).not.toBe(
      render(parsed('{b}\n', 'mdx').children),
    );
  });
});

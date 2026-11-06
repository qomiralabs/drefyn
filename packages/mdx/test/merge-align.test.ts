import { describe, expect, it } from 'vitest';
import { rawOf } from '../src/index.ts';
import { align, shareHeld, SIMILARITY_BUDGET, similarity } from '../src/merge-align.ts';
import type { Entry, MergeNode } from '../src/merge-align.ts';
import type { MdxBlock } from '../src/index.ts';

const text = (type: string, value: string): MergeNode => ({ type, value });
const paragraph = (value: string): MergeNode => ({
  type: 'paragraph',
  children: [{ type: 'text', value }],
});
const entry = (node: MergeNode): Entry => ({
  node,
  hash: rawOf(node as unknown as MdxBlock),
  previous: null,
});
const line = (value: string) => entry(paragraph(value));
const wide = () => ({ left: SIMILARITY_BUDGET });
const states = (base: readonly Entry[], side: readonly Entry[], budget = wide()) =>
  align(base, side, budget).slots.map(({ state }) => state);

describe('similarity', () => {
  it('is the share of words two blocks have in common', () => {
    expect(similarity(line('one two three'), line('one two four'), wide())).toBe(0.5);
    expect(similarity(line('one two'), line('one two'), wide())).toBe(1);
  });

  it('compares whole words, without case', () => {
    expect(similarity(line('Stable'), line('stable'), wide())).toBe(1);
    expect(similarity(line('stable'), line('ablest'), wide())).toBe(0);
  });

  it('says nothing across kinds', () => {
    const budget = wide();
    expect(similarity(entry(text('code', 'one')), line('one'), budget)).toBe(0);
    expect(budget.left).toBe(SIMILARITY_BUDGET - 1);
  });

  it('calls two blocks with no words the same, and one with none different', () => {
    const rule = () => entry({ type: 'thematicBreak' });
    expect(similarity(rule(), rule(), wide())).toBe(1);
    expect(similarity(line(''), line('words'), wide())).toBe(0);
    expect(similarity(line('words'), line(''), wide())).toBe(0);
  });

  it('charges one for the look and one for each word', () => {
    const budget = { left: 10 };
    similarity(line('one two three'), line('one'), budget);
    expect(budget.left).toBe(6);
  });

  it('stops counting once the budget is gone', () => {
    expect(similarity(line('one two'), line('one two'), { left: 1 })).toBe(0);
    expect(similarity(line('one two'), line('one two'), { left: 3 })).toBe(1);
  });
});

describe('shareHeld', () => {
  const quote = (value: string): Entry =>
    entry({ type: 'blockquote', children: [paragraph(value)] });

  it('is the share of a block its rewrite still holds, whatever kind that is', () => {
    expect(shareHeld(line('one two three four'), quote('one two three five'), wide())).toBe(0.75);
    expect(shareHeld(line('one two'), quote('nothing here'), wide())).toBe(0);
  });

  it('measures against the block that went, not the one it landed in', () => {
    expect(shareHeld(line('one two'), line('one two three four five six'), wide())).toBe(1);
    expect(shareHeld(line('one two three four five six'), line('one two'), wide())).toBeCloseTo(
      1 / 3,
    );
  });

  it('tells blocks with no words apart by kind', () => {
    const rule = () => entry({ type: 'thematicBreak' });
    expect(shareHeld(rule(), rule(), wide())).toBe(1);
    expect(shareHeld(rule(), entry({ type: 'html', value: '' }), wide())).toBe(0);
    expect(shareHeld(rule(), line('words'), wide())).toBe(0);
  });

  it('charges one for the look and one for each word, and may spend the last of it', () => {
    const budget = { left: 3 };
    expect(shareHeld(line('one two'), line('one two'), budget)).toBe(1);
    expect(budget.left).toBe(0);
    expect(shareHeld(line('one two'), line('one two'), { left: 2 })).toBe(0);
  });

  it('finds words in image text, links, titles, code and attributes', () => {
    const held = (node: MergeNode, value: string) => shareHeld(line(value), entry(node), wide());
    expect(held({ type: 'image', alt: 'hidden' }, 'hidden')).toBe(1);
    expect(held({ type: 'image', url: 'https://hidden' }, 'hidden')).toBe(1);
    expect(held({ type: 'image', title: 'hidden' }, 'hidden')).toBe(1);
    expect(held({ type: 'code', value: 'hidden' }, 'hidden')).toBe(1);
    expect(held({ type: 'mdxJsxFlowElement', name: 'Hidden' }, 'hidden')).toBe(1);
    const attribute = { type: 'mdxJsxAttribute', name: 'a', value: 'hidden' };
    expect(held({ type: 'mdxJsxFlowElement', attributes: [attribute] }, 'hidden')).toBe(1);
    const expression = { type: 'mdxJsxAttributeValueExpression', value: 'hidden' };
    const bound = { type: 'mdxJsxAttribute', name: 'a', value: expression };
    expect(held({ type: 'mdxJsxFlowElement', attributes: [bound] }, 'hidden')).toBe(1);
    const deep = {
      type: 'blockquote',
      children: [{ type: 'paragraph', children: [{ type: 'image', alt: 'hidden' }] }],
    };
    expect(held(deep, 'hidden')).toBe(1);
    expect(held({ type: 'image', alt: 'other' }, 'hidden')).toBe(0);
    expect(held({ type: 'html', value: null }, 'hidden')).toBe(0);
  });
});

describe('align', () => {
  const a = line('alpha beta gamma delta');
  const b = line('epsilon zeta eta theta');
  const c = line('iota kappa lambda mu');

  it('finds same, changed and deleted slots', () => {
    const edited = line('epsilon zeta eta iota');
    expect(states([a, b, c], [a, edited])).toEqual(['same', 'changed', 'deleted']);
  });

  it('puts a new block after the slot above it', () => {
    const fresh = line('nothing like the others');
    const { after } = align([a, b], [a, fresh, b]);
    expect(after.map((list) => list.map(({ spot }) => spot))).toEqual([[], [1], []]);
  });

  it('puts a new block above the first slot', () => {
    const { after } = align([a], [line('nothing like the others'), a]);
    expect(after.map(({ length }) => length)).toEqual([1, 0]);
  });

  it('marks an untouched move as moved, not edited', () => {
    const { slots, after } = align([a, b, c], [b, c, a]);
    expect(slots[0]).toMatchObject({ state: 'moved', edited: false });
    expect(after[3]?.[0]?.movedFrom).toBe(0);
  });

  it('marks a move that also changed words as edited', () => {
    const { slots } = align([a, b, c], [b, c, line('alpha beta gamma omega')]);
    expect(slots[0]).toMatchObject({ state: 'moved', edited: true });
  });

  it('prefers the exact copy over a closer looking slot', () => {
    const close = line('alpha beta gamma delta extra');
    const { slots } = align([close, b, a], [b, a, close].reverse());
    expect(slots.filter(({ state }) => state === 'moved').length).toBeGreaterThan(0);
    const moved = slots.flatMap((slot) => (slot.state === 'moved' ? [slot.edited] : []));
    expect(moved).not.toContain(true);
  });

  it('moves each copy of a repeated block once', () => {
    const d = line('nu xi omicron pi');
    const { slots } = align([a, a, b, c, d], [b, c, d, a, a]);
    expect(slots.map(({ state }) => state)).toEqual(['moved', 'moved', 'same', 'same', 'same']);
    const fewer = align([a, a, b, c, d], [b, c, d, a]);
    expect(fewer.slots.map(({ state }) => state)).toEqual([
      'moved',
      'deleted',
      'same',
      'same',
      'same',
    ]);
  });

  it('never gives one deleted slot to two moved and edited blocks', () => {
    const { slots, after } = align(
      [a, b],
      [b, line('alpha beta gamma one'), line('alpha beta gamma two')],
    );
    expect(slots.filter(({ state }) => state === 'moved')).toHaveLength(1);
    expect(after.flat().filter(({ movedFrom }) => movedFrom === undefined)).toHaveLength(1);
  });

  it('never gives a slot two blocks of the same words', () => {
    const left = line('alpha beta gamma one');
    const right = line('alpha beta gamma two');
    const out = align([b, c], [left, right, b, c]);
    expect(out.after[0]).toHaveLength(2);
    expect(out.slots.map(({ state }) => state)).toEqual(['same', 'same']);
  });

  it('pairs a block with the closest slot in its run', () => {
    const near = line('one two three four five six');
    const nearer = line('one two three four five seven');
    const edited = line('one two three four five seven eight');
    const out = align([a, near, nearer, c], [a, edited, c]);
    expect(out.slots.map(({ state }) => state)).toEqual(['same', 'deleted', 'changed', 'same']);
  });

  it('takes the first of two equally close slots', () => {
    const one = line('one two three x');
    const two = line('one two three y');
    const edited = line('one two three z');
    const out = align([a, one, two, c], [a, edited, c]);
    expect(out.slots.map(({ state }) => state)).toEqual(['same', 'changed', 'deleted', 'same']);
  });

  it('leaves a block with too little in common unpaired', () => {
    const edited = line('alpha beta other words here now');
    expect(states([a, b], [edited, b])).toEqual(['deleted', 'same']);
  });

  it('does not pair a block that has an exact copy in the base', () => {
    const start = line('one two three x');
    const other = line('one two three y');
    const out = align([start, other, c], [other, start, c]);
    expect(out.slots.filter(({ state }) => state === 'changed')).toHaveLength(0);
  });

  it('leaves a block with an exact copy for its move, whatever slot looks like it', () => {
    const copy = line('one two three x');
    const twin = line('one two three y');
    expect(states([copy, b, twin, c], [b, copy, c])).toEqual(['moved', 'same', 'deleted', 'same']);
  });

  it('never moves frontmatter', () => {
    const yaml = entry(text('yaml', 'title: a'));
    const { slots, after } = align(
      [yaml, a, b],
      [a, yaml, b].slice(0, 2).reverse().slice(1).concat(b),
    );
    expect(slots[0]?.state).toBe('deleted');
    expect(after.flat().some(({ movedFrom }) => movedFrom === 0)).toBe(false);
    const edited = entry(text('yaml', 'title: a'));
    const down = align([yaml, a, b], [a, edited, b]);
    expect(down.slots.map(({ state }) => state)).toEqual(['deleted', 'same', 'same']);
  });

  it('treats everything as a delete and an insert with no budget left', () => {
    const edited = line('alpha beta gamma omega');
    const spent = align([a, b], [edited, b], { left: -1 });
    expect(spent.slots.map(({ state }) => state)).toEqual(['deleted', 'same']);
    expect(spent.after.flat()).toHaveLength(1);
  });

  it('gives up pairing at its default budget, where a wider one would go on', () => {
    const rows = 3_000;
    const row = (at: number, last: string) => line(`w${at}a w${at}b w${at}c ${last}`);
    const base = Array.from({ length: rows }, (_, at) => row(at, 'x'));
    const side = Array.from({ length: rows }, (_, at) => row(at, 'y'));
    const last = (budget?: { left: number }) => align(base, side, budget).slots.at(-1)?.state;
    expect(last()).toBe('deleted');
    expect(last({ left: Infinity })).toBe('changed');
  });

  it('still takes an exact move with no budget left', () => {
    expect(states([a, b, c], [b, c, a], { left: -1 })).toEqual(['moved', 'same', 'same']);
  });

  it('stops looking for edited moves when the budget is gone', () => {
    const first = line('alpha beta gamma one');
    const out = align([a, b, c], [b, c, first], { left: 1_000 });
    expect(out.slots[0]).toMatchObject({ state: 'moved', edited: true });
    const gone = align([a, b, c], [b, c, first], { left: -1 });
    expect(gone.slots[0]?.state).toBe('deleted');
  });
});

import { describe, expect, it } from 'vitest';
import { DEFAULT_MERGE_MAX_BLOCKS, merge3 } from '../src/merge3.ts';
import { printPage } from '../src/print-job.ts';
import type { BlockConflict, MdxBlock, MdxRoot, MergeOutcome } from '../src/index.ts';
import { rawOf } from '../src/index.ts';
import { isolatedPolicy, parsed } from './helpers.ts';

const PAGE = [
  '# Title',
  'First paragraph with several plain words here.',
  'Second paragraph with several other words here.',
  'Third paragraph about something else entirely now.',
  'Fourth paragraph that closes the page off nicely.',
].join('\n\n');

const page = (...blocks: readonly string[]) => `${blocks.join('\n\n')}\n`;
const BASE = `${PAGE}\n`;
const replaced = (from: string, to: string, text = BASE) => {
  expect(text).toContain(from);
  return text.replace(from, to);
};

function outcomeOf(base: string, ours: string, theirs: string, dialect: 'md' | 'mdx' = 'md') {
  const result = merge3(parsed(base, dialect), parsed(ours, dialect), parsed(theirs, dialect));
  if (!result.ok) throw new Error(`refused: ${result.error[0]?.code ?? ''}`);
  return result.value;
}

function printed(root: MdxRoot): string {
  const answer = printPage({ tree: JSON.stringify(root), policy: isolatedPolicy() });
  if (!answer.ok) throw new Error(`print refused: ${answer.error[0]?.code ?? ''}`);
  return answer.value.text;
}

function clean(outcome: MergeOutcome): string {
  if (outcome.kind !== 'clean') {
    throw new Error(`conflicts: ${outcome.conflicts.map(({ reason }) => reason).join(' ')}`);
  }
  return printed(outcome.merged);
}

function conflicts(outcome: MergeOutcome): readonly BlockConflict[] {
  if (outcome.kind !== 'conflict') throw new Error('merged clean');
  return outcome.conflicts;
}

const withoutMiddle = (root: MdxRoot): MdxRoot => ({
  ...root,
  children: root.children.filter((_, index) => index !== 1),
});

const textOf = (block: MdxBlock | null) => (block === null ? null : block.source?.raw);
const brief = (list: readonly BlockConflict[]) =>
  list.map(({ baseIndex, reason, ours, theirs }) => ({
    baseIndex,
    reason,
    ours: textOf(ours),
    theirs: textOf(theirs),
  }));

describe('merge3 scenarios', () => {
  it('adjacent blocks: an edit on each side of a block boundary both land', () => {
    const ours = replaced('First paragraph', 'First OURS paragraph');
    const theirs = replaced('Second paragraph', 'Second THEIRS paragraph');
    expect(clean(outcomeOf(BASE, ours, theirs))).toBe(
      replaced('Second paragraph', 'Second THEIRS paragraph', ours),
    );
  });

  it('far apart blocks: both edits land', () => {
    const ours = replaced('# Title', '# Title OURS');
    const theirs = replaced('Fourth paragraph', 'Fourth THEIRS paragraph');
    expect(clean(outcomeOf(BASE, ours, theirs))).toBe(
      replaced('Fourth paragraph', 'Fourth THEIRS paragraph', ours),
    );
  });

  it('same block both ends: the edits merge inside the block', () => {
    const ours = replaced('First paragraph', 'OURS First paragraph');
    const theirs = replaced('words here.\n\nSecond', 'words THEIRS here.\n\nSecond');
    expect(clean(outcomeOf(BASE, ours, theirs))).toBe(
      replaced(
        'First paragraph with several plain words here.',
        'OURS First paragraph with several plain words THEIRS here.',
      ),
    );
  });

  it('same block, same word on both sides: a conflict with both versions recorded', () => {
    const ours = replaced('several plain', 'several OURS');
    const theirs = replaced('several plain', 'several THEIRS');
    const outcome = outcomeOf(BASE, ours, theirs);
    expect(brief(conflicts(outcome))).toEqual([
      {
        baseIndex: 1,
        reason: 'both_changed',
        ours: 'First paragraph with several OURS words here.',
        theirs: 'First paragraph with several THEIRS words here.',
      },
    ]);
  });

  it('same edit on both sides: it lands once, with no conflict', () => {
    const edit = replaced('Third paragraph', 'Third SAME paragraph');
    expect(clean(outcomeOf(BASE, edit, edit))).toBe(edit);
  });

  it('insert beside an edit: both land, the insert in its place', () => {
    const ours = replaced('Second paragraph', 'New OURS block.\n\nSecond paragraph');
    const theirs = replaced('Second paragraph', 'Second THEIRS paragraph');
    expect(clean(outcomeOf(BASE, ours, theirs))).toBe(
      replaced('Second paragraph', 'Second THEIRS paragraph', ours),
    );
  });

  it('both insert at one spot: a conflict records each side and both stay on the page', () => {
    const ours = replaced('Second paragraph', 'New OURS block.\n\nSecond paragraph');
    const theirs = replaced('Second paragraph', 'New THEIRS block.\n\nSecond paragraph');
    const outcome = outcomeOf(BASE, ours, theirs);
    expect(brief(conflicts(outcome))).toEqual([
      {
        baseIndex: 1,
        reason: 'both_inserted',
        ours: 'New OURS block.',
        theirs: 'New THEIRS block.',
      },
    ]);
    if (outcome.kind !== 'conflict') return;
    expect(printed(outcome.partial)).toContain('New OURS block.\n\nNew THEIRS block.');
  });

  it('both insert at one spot, unevenly: every inserted block is in a conflict', () => {
    const ours = replaced('Second paragraph', 'One OURS.\n\nTwo OURS.\n\nSecond paragraph');
    const theirs = replaced('Second paragraph', 'One THEIRS.\n\nSecond paragraph');
    expect(brief(conflicts(outcomeOf(BASE, ours, theirs)))).toEqual([
      { baseIndex: 1, reason: 'both_inserted', ours: 'One OURS.', theirs: 'One THEIRS.' },
      { baseIndex: 1, reason: 'both_inserted', ours: 'Two OURS.', theirs: null },
    ]);
  });

  it('both insert the same block at one spot: one copy, no conflict', () => {
    const edit = replaced('Second paragraph', 'New SAME block.\n\nSecond paragraph');
    expect(clean(outcomeOf(BASE, edit, edit))).toBe(edit);
  });

  it('both insert at the very top: the slot has no base index', () => {
    const ours = `OURS on top.\n\n${BASE}`;
    const theirs = `THEIRS on top.\n\n${BASE}`;
    expect(brief(conflicts(outcomeOf(BASE, ours, theirs)))).toEqual([
      { baseIndex: null, reason: 'both_inserted', ours: 'OURS on top.', theirs: 'THEIRS on top.' },
    ]);
  });

  it('delete vs edit: a conflict keeps the edit on the page and in the record', () => {
    const ours = replaced('Second paragraph with several other words here.\n\n', '');
    const theirs = replaced('Second paragraph', 'Second THEIRS paragraph');
    const outcome = outcomeOf(BASE, ours, theirs);
    expect(brief(conflicts(outcome))).toEqual([
      {
        baseIndex: 2,
        reason: 'delete_vs_edit',
        ours: null,
        theirs: 'Second THEIRS paragraph with several other words here.',
      },
    ]);
    if (outcome.kind !== 'conflict') return;
    expect(printed(outcome.partial)).toContain('Second THEIRS paragraph');
  });

  it('delete with no edit on the other side is honoured', () => {
    const ours = replaced('Second paragraph with several other words here.\n\n', '');
    const theirs = replaced('# Title', '# Title THEIRS');
    expect(clean(outcomeOf(BASE, ours, theirs))).not.toContain('Second paragraph');
  });

  it('both delete: gone with no conflict', () => {
    const edit = replaced('Second paragraph with several other words here.\n\n', '');
    expect(clean(outcomeOf(BASE, edit, edit))).toBe(edit);
  });

  it('a rewrite too different to pair still answers the other side deleting it', () => {
    const blocks = ['Keep this one.', 'alpha beta gamma delta epsilon', 'Keep that one.'];
    const base = page(...blocks);
    const ours = page(blocks[0] ?? '', 'alpha zeta eta theta iota kappa lambda', blocks[2] ?? '');
    const theirs = page(blocks[0] ?? '', blocks[2] ?? '');
    const list = conflicts(outcomeOf(base, ours, theirs));
    expect(list.map(({ reason }) => reason)).toEqual(['delete_vs_edit']);
    expect(list[0]?.ours?.source?.raw).toContain('zeta');
  });

  it('a block fused into another still answers the other side deleting it', () => {
    const base = '    first code\n\n```\nmiddle\n```\n\n    second code\n\nWords.\n';
    const ours = '    second code\n\n    first code\n\n```\nmiddle\n```\n\nWords.\n';
    const theirs = '    first code\n\n```\nmiddle\n```\n\nWords.\n';
    const list = conflicts(outcomeOf(base, ours, theirs));
    const deleted = list.find(({ reason }) => reason === 'delete_vs_edit');
    expect(deleted?.baseIndex).toBe(2);
    expect(deleted?.ours?.source?.raw).toContain('second code');
  });

  it('a block a list took in cannot be placed against an insert beside that list', () => {
    const base = '- item one\n\n> quote\n\n    code words\n\nEnd.\n';
    const ours = '- item one\n\nNew OURS.\n\n> quote\n\n    code words\n\nEnd.\n';
    const theirs = '- item one\n\n    code words\n\nEnd.\n';
    expect(parsed(theirs, 'md').children).toHaveLength(2);
    const list = conflicts(outcomeOf(base, ours, theirs));
    expect(list.map(({ baseIndex, reason }) => [baseIndex, reason])).toEqual([[0, 'both_changed']]);
  });

  it('move vs edit: the edit follows the block to where it moved', () => {
    const moved = 'Second paragraph with several other words here.';
    const ours = replaced(`${moved}\n\n`, '').replace('nicely.', `nicely.\n\n${moved}`);
    const theirs = replaced('Second paragraph', 'Second THEIRS paragraph');
    expect(clean(outcomeOf(BASE, ours, theirs))).toBe(
      page(
        '# Title',
        'First paragraph with several plain words here.',
        'Third paragraph about something else entirely now.',
        'Fourth paragraph that closes the page off nicely.',
        'Second THEIRS paragraph with several other words here.',
      ),
    );
  });

  it('move vs edit, with an insert beside the moved block: a conflict', () => {
    const moved = 'Second paragraph with several other words here.';
    const ours = replaced(`${moved}\n\n`, '').replace('nicely.', `nicely.\n\n${moved}`);
    const theirs = replaced('Third paragraph', 'New THEIRS block.\n\nThird paragraph');
    const list = conflicts(outcomeOf(BASE, ours, theirs));
    expect(list.map(({ baseIndex, reason }) => [baseIndex, reason])).toEqual([[2, 'move_vs_edit']]);
  });

  it('move vs delete: a conflict, and the moved block stays', () => {
    const moved = 'Second paragraph with several other words here.';
    const ours = replaced(`${moved}\n\n`, '').replace('nicely.', `nicely.\n\n${moved}`);
    const theirs = replaced(`${moved}\n\n`, '');
    const outcome = outcomeOf(BASE, ours, theirs);
    expect(brief(conflicts(outcome))).toEqual([
      { baseIndex: 2, reason: 'move_vs_edit', ours: moved, theirs: null },
    ]);
  });

  it('a moved and edited block merges with an edit at its other end', () => {
    const moved = 'Second paragraph with several other words here.';
    const ours = replaced(`${moved}\n\n`, '').replace('nicely.', `nicely.\n\nOURS ${moved}`);
    const theirs = replaced('words here.\n\nThird', 'words THEIRS here.\n\nThird');
    const text = clean(outcomeOf(BASE, ours, theirs));
    expect(text).toContain(
      'nicely.\n\nOURS Second paragraph with several other words THEIRS here.\n',
    );
  });

  it('a moved and edited block that cannot merge with the other edit is a conflict', () => {
    const moved = 'Second paragraph with several other words here.';
    const ours = replaced(`${moved}\n\n`, '').replace(
      'nicely.',
      `nicely.\n\n${moved.replace('several', 'OURS')}`,
    );
    const theirs = replaced('several other', 'THEIRS other');
    const list = conflicts(outcomeOf(BASE, ours, theirs));
    expect(list.map(({ reason }) => reason)).toEqual(['move_vs_edit']);
  });

  it('both move a block to one spot: it lands once', () => {
    const moved = 'Second paragraph with several other words here.';
    const edit = replaced(`${moved}\n\n`, '').replace('nicely.', `nicely.\n\n${moved}`);
    expect(clean(outcomeOf(BASE, edit, edit))).toBe(edit);
  });

  it('both move a block to different spots: a conflict names both', () => {
    const moved = 'Second paragraph with several other words here.';
    const ours = replaced(`${moved}\n\n`, '').replace('nicely.', `nicely.\n\n${moved}`);
    const theirs = `${moved}\n\n${replaced(`${moved}\n\n`, '')}`;
    expect(brief(conflicts(outcomeOf(BASE, ours, theirs)))).toEqual([
      { baseIndex: 2, reason: 'move_vs_edit', ours: moved, theirs: moved },
    ]);
  });

  it('reformat vs edit: no conflict, and the reformat keeps its bytes', () => {
    const base = '# Title\n\n- one\n- two\n\nA paragraph of words.\n';
    const ours = base.replace('- one\n- two', '* one\n* two');
    const theirs = base.replace('A paragraph', 'A THEIRS paragraph');
    expect(clean(outcomeOf(base, ours, theirs))).toBe(
      '# Title\n\n* one\n* two\n\nA THEIRS paragraph of words.\n',
    );
  });

  it('reformat of a block the other side edited: the edit wins with no conflict', () => {
    const base = '# Title\n\n- one\n- two\n';
    const ours = base.replace('- one\n- two', '* one\n* two');
    const theirs = base.replace('two', 'THEIRS');
    expect(clean(outcomeOf(base, ours, theirs))).toBe('# Title\n\n- one\n- THEIRS\n');
  });

  it('reformat on both sides picks the same bytes whichever side comes first', () => {
    const base = '- one\n- two\n';
    const ours = '* one\n* two\n';
    const theirs = '+ one\n+ two\n';
    const here = clean(outcomeOf(base, ours, theirs));
    expect(here).toBe(clean(outcomeOf(base, theirs, ours)));
    expect([ours, theirs]).toContain(here);
  });
});

describe('merge3 inside blocks', () => {
  const list = '- one item\n- two item\n- three item\n- four item\n';

  it('merges edits to two items of one list', () => {
    const ours = list.replace('one item', 'one OURS');
    const theirs = list.replace('four item', 'four THEIRS');
    expect(clean(outcomeOf(list, ours, theirs))).toBe(
      '- one OURS\n- two item\n- three item\n- four THEIRS\n',
    );
  });

  it('merges an added item with an edit elsewhere in the list', () => {
    const ours = list.replace('- two', '- new OURS\n- two');
    const theirs = list.replace('four item', 'four THEIRS');
    expect(clean(outcomeOf(list, ours, theirs))).toBe(
      '- one item\n- new OURS\n- two item\n- three item\n- four THEIRS\n',
    );
  });

  it('two edits to one word of one item are a conflict on the whole list', () => {
    const ours = list.replace('two item', 'two OURS');
    const theirs = list.replace('two item', 'two THEIRS');
    expect(
      conflicts(outcomeOf(list, ours, theirs)).map(({ reason, baseIndex }) => [baseIndex, reason]),
    ).toEqual([[0, 'both_changed']]);
  });

  it('deleting every item from two sides drops the list', () => {
    const base = 'Before.\n\n- one\n- two\n\nAfter.\n';
    const ours = base.replace('- one\n', '');
    const theirs = base.replace('- two\n', '');
    expect(clean(outcomeOf(base, ours, theirs))).toBe('Before.\n\nAfter.\n');
  });

  it('a task box checked on one side and text edited on the other both land', () => {
    const base = '- [ ] one thing\n- [ ] two thing\n';
    const ours = base.replace('[ ] one', '[x] one');
    const theirs = base.replace('one thing', 'one THEIRS thing');
    expect(clean(outcomeOf(base, ours, theirs))).toBe('- [x] one THEIRS thing\n- [ ] two thing\n');
  });

  it('a task box set two ways on one item is a conflict', () => {
    const base = '- [ ] one thing\n';
    const ours = '- [x] one thing\n';
    const theirs = '- one THEIRS thing\n';
    expect(conflicts(outcomeOf(base, ours, theirs))).toHaveLength(1);
  });

  it('a list turned ordered on one side and edited on the other', () => {
    const ours = list.replace(/^- /gm, '1. ');
    const theirs = list.replace('four item', 'four THEIRS');
    expect(clean(outcomeOf(list, ours, theirs))).toContain('four THEIRS');
  });

  const table = '| a | b |\n| - | - |\n| one | two |\n| three | four |\n| five | six |\n';

  it('merges edits to two rows of one table', () => {
    const ours = table.replace('one', 'ONE');
    const theirs = table.replace('six', 'SIX');
    expect(clean(outcomeOf(table, ours, theirs))).toContain(
      '| ONE | two |\n| three | four |\n| five | SIX |',
    );
  });

  it('merges edits to two cells of one row', () => {
    const ours = table.replace('one', 'ONE');
    const theirs = table.replace('two', 'TWO');
    expect(clean(outcomeOf(table, ours, theirs))).toContain('ONE');
  });

  it('a new row beside an edited row', () => {
    const ours = table.replace('| five', '| new | row |\n| five');
    const theirs = table.replace('one', 'ONE');
    const text = clean(outcomeOf(table, ours, theirs));
    expect(text).toContain('new');
    expect(text).toContain('ONE');
  });

  it('a column change that would leave rows uneven is a conflict', () => {
    const base = '| a | b |\n| - | - |\n| one | two |\n';
    const ours = '| a | b | c |\n| - | - | - |\n| one | two | x |\n';
    const theirs = '| a | b |\n| - | - |\n| one | two |\n| new | row |\n';
    expect(conflicts(outcomeOf(base, ours, theirs))).toHaveLength(1);
  });

  it('an alignment changed on one side stays while the other edits a row', () => {
    const ours = table.replace('| - | - |', '| :- | -: |');
    const theirs = table.replace('six', 'SIX');
    const text = clean(outcomeOf(table, ours, theirs));
    expect(text).toContain('SIX');
    expect(text).toMatch(/\| :-+ \| -+: \|/);
  });

  it('alignment changed two ways is a conflict', () => {
    const ours = table.replace('| - | - |', '| :- | - |');
    const theirs = table.replace('| - | - |', '| -: | - |');
    expect(conflicts(outcomeOf(table, ours, theirs))).toHaveLength(1);
  });

  it('merges edits in a block quote', () => {
    const base = '> one line\n>\n> two line\n';
    const ours = base.replace('one line', 'one OURS');
    const theirs = base.replace('two line', 'two THEIRS');
    expect(clean(outcomeOf(base, ours, theirs))).toBe('> one OURS\n>\n> two THEIRS\n');
  });

  it('merges a heading edited at both ends', () => {
    const base = '# Some good title here\n';
    const ours = '# OURS good title here\n';
    const theirs = '# Some good title THEIRS\n';
    expect(clean(outcomeOf(base, ours, theirs))).toBe('# OURS good title THEIRS\n');
  });

  it('a heading depth changed two ways is a conflict', () => {
    const base = '# Some good title here\n';
    expect(
      conflicts(outcomeOf(base, '## Some good title here\n', '### Some good title here\n')),
    ).toHaveLength(1);
  });

  it('a heading depth changed on one side keeps it beside a word edit', () => {
    const base = '# Some good title here\n';
    const text = clean(outcomeOf(base, '## Some good title here\n', '# Some good THEIRS here\n'));
    expect(text).toBe('## Some good THEIRS here\n');
  });

  it('never merges inside code: an edit on each side is a conflict', () => {
    const base = '```js\none\ntwo\nthree\nfour\nfive\n```\n';
    const ours = base.replace('one', 'OURS');
    const theirs = base.replace('five', 'THEIRS');
    expect(conflicts(outcomeOf(base, ours, theirs)).map(({ reason }) => reason)).toEqual([
      'both_changed',
    ]);
  });

  it('a block whose kind changed on one side and text on the other is a conflict', () => {
    const base = 'Some plain words on a line here.\n';
    const ours = '# Some plain words on a line here.\n';
    const theirs = 'Some plain THEIRS on a line here.\n';
    expect(conflicts(outcomeOf(base, ours, theirs)).length).toBeGreaterThan(0);
  });

  it('an inline merge that would make a second block is a conflict', () => {
    const base = 'Some plain words on a line here.\n\nNext block.\n';
    const ours = 'Some plain words on a line here.\n\n# Head\n\nNext block.\n';
    const theirs = 'Some plain words on a line THEIRS.\n\nNext block.\n';
    expect(clean(outcomeOf(base, ours, theirs))).toContain('# Head');
  });

  it('keeps a reference resolved while it reprints a merged block', () => {
    const base = 'See [the docs][d] for more about this topic.\n\n[d]: https://a.example\n';
    const ours = 'OURS See [the docs][d] for more about this topic.\n\n[d]: https://a.example\n';
    const theirs = 'See [the docs][d] for more about THEIRS.\n\n[d]: https://a.example\n';
    expect(clean(outcomeOf(base, ours, theirs))).toBe(
      'OURS See [the docs][d] for more about THEIRS.\n\n[d]: https://a.example\n',
    );
  });

  it('merges with footnote definitions on the page', () => {
    const base = 'Words here[^1] and more words there.\n\n[^1]: The note.\n';
    const ours = base.replace('Words here', 'OURS here');
    const theirs = base.replace('words there', 'words THEIRS');
    expect(clean(outcomeOf(base, ours, theirs))).toContain('OURS here[^1] and more words THEIRS.');
  });
});

describe('merge3 output', () => {
  it('keeps the bytes of untouched blocks and the gap of a merged one', () => {
    const base = '#   Odd   title\n\n\n\nSome plain words on a line here.\n';
    const ours = '#   Odd   title\n\n\n\nOURS plain words on a line here.\n';
    const theirs = '#   Odd   title\n\n\n\nSome plain words on a line THEIRS.\n';
    expect(clean(outcomeOf(base, ours, theirs))).toBe(
      '#   Odd   title\n\n\n\nOURS plain words on a line THEIRS.\n',
    );
  });

  it('opens a tight gap when the block above it changes', () => {
    const base = '# Title\nWords under the title.\n\nAnother block.\n';
    const ours = '# Title\n\nOURS block.\n\nWords under the title.\n\nAnother block.\n'.replace(
      'OURS block.\n\n',
      '',
    );
    const theirs = 'Another block.\n\n# Title\nWords under the title.\n';
    expect(clean(outcomeOf(base, ours, theirs))).toContain('# Title\n');
  });

  it('a block that lost its neighbour cannot run into the block now above it', () => {
    const base = 'First words.\n\n# Title\nTight words.\n';
    const ours = 'First words.\n\nTight words.\n';
    const theirs = base.replace('First words.', 'First THEIRS.');
    expect(clean(outcomeOf(base, ours, theirs))).toBe('First THEIRS.\n\nTight words.\n');
  });

  it('reprints an indented block that a change left under a list', () => {
    const base = '- item one\n\n# Title\n\n    indented code\n';
    const ours = '- item one\n\n    indented code\n'.replace(
      '- item one\n\n',
      '- item one\n\n# Other\n\n',
    );
    const theirs = base.replace('item one', 'item THEIRS');
    expect(clean(outcomeOf(base, ours, theirs))).toContain('indented code');
    const gone = '- item one\n\nWords.\n\n    indented code\n';
    const deleted = gone.replace('Words.\n\n', '');
    expect(parsed(deleted, 'md').children).toHaveLength(1);
    const edited = gone.replace('item one', 'item THEIRS');
    const left = merge3(
      parsed(gone, 'md'),
      withoutMiddle(parsed(gone, 'md')),
      parsed(edited, 'md'),
    );
    if (!left.ok || left.value.kind !== 'clean') throw new Error('expected clean');
    expect(printed(left.value.merged)).toBe('- item THEIRS\n\n```\nindented code\n```\n');
  });

  it('keeps the BOM when the first block opens up beside a new neighbour', () => {
    const bom = String.fromCharCode(0xfeff);
    const base = `${bom}# Title\nTight words.\n`;
    const ours = parsed(base, 'md');
    const added = {
      type: 'paragraph' as const,
      children: [{ type: 'text' as const, value: 'New.' }],
    };
    const inserted = { ...ours, children: [added, ...ours.children] };
    const theirs = parsed(base.replace('Tight', 'Tight THEIRS'), 'md');
    const result = merge3(parsed(base, 'md'), inserted, theirs);
    if (!result.ok || result.value.kind !== 'clean') throw new Error('expected clean');
    expect(printed(result.value.merged)).toBe(`${bom}New.\n\n# Title\nTight THEIRS words.\n`);
  });

  it('opens no blank lines at the top when the first block goes', () => {
    const base = '# Title\n\nWords here.\n\nMore words.\n';
    const ours = 'Words here.\n\nMore words.\n';
    const theirs = base.replace('More', 'THEIRS');
    expect(clean(outcomeOf(base, ours, theirs))).toBe('Words here.\n\nTHEIRS words.\n');
  });

  it('keeps the gap above a rule that comes to the top, or it would open frontmatter', () => {
    const base = 'Words here.\n\n---\n\nMore words.\n\n---\n';
    const ours = '\n\n---\n\nMore words.\n\n---\n';
    const theirs = base.replace('More', 'THEIRS');
    const text = clean(outcomeOf(base, ours, theirs));
    expect(parsed(text, 'md').children.map(({ type }) => type)).toEqual([
      'thematicBreak',
      'paragraph',
      'thematicBreak',
    ]);
  });

  it('changes the file ending when one side did', () => {
    const base = 'One.\n\nTwo.\n';
    const ours = 'One.\r\n\r\nTwo.\r\n';
    const theirs = 'One.\n\nTwo THEIRS.\n';
    const outcome = outcomeOf(base, ours, theirs);
    expect(outcome.kind === 'clean' && outcome.merged.eol).toBe('crlf');
    const swapped = outcomeOf(base, theirs, ours);
    expect(swapped.kind === 'clean' && swapped.merged.eol).toBe('crlf');
  });

  it('takes a tail change from whichever side made it', () => {
    const base = 'One.\n';
    const ours = 'One.\n\n\n';
    const theirs = 'One.';
    const swapped = (left: string, right: string) => clean(outcomeOf(base, left, right));
    expect(swapped(base, ours)).toBe(ours);
    expect(swapped(ours, base)).toBe(ours);
    expect(swapped(ours, theirs)).toBe(swapped(theirs, ours));
  });

  it('settles the same tree whichever side comes first, byte for byte', () => {
    const ours = replaced('First paragraph', 'OURS First paragraph');
    const theirs = replaced('words here.\n\nSecond', 'words THEIRS here.\n\nSecond');
    expect(clean(outcomeOf(BASE, ours, theirs))).toBe(clean(outcomeOf(BASE, theirs, ours)));
  });

  it('gives identical output on every run', () => {
    const ours = parsed(replaced('First paragraph', 'OURS First paragraph'), 'md');
    const theirs = parsed(replaced('Second paragraph', 'New.\n\nSecond paragraph'), 'md');
    const base = parsed(BASE, 'md');
    expect(JSON.stringify(merge3(base, ours, theirs))).toBe(
      JSON.stringify(merge3(base, ours, theirs)),
    );
  });

  it('leaves its input alone', () => {
    const freeze = (value: unknown): void => {
      if (typeof value !== 'object' || value === null) return;
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    };
    const roots = [
      BASE,
      replaced('First', 'OURS First'),
      replaced('words here.\n\nSecond', 'THEIRS.\n\nSecond'),
    ].map((text) => parsed(text, 'md'));
    roots.forEach(freeze);
    const [base, ours, theirs] = roots as [MdxRoot, MdxRoot, MdxRoot];
    expect(merge3(base, ours, theirs).ok).toBe(true);
  });

  it('merges nothing against nothing', () => {
    expect(clean(outcomeOf('', '', ''))).toBe('');
  });

  it('hands back the other side when one side did nothing', () => {
    const theirs = replaced('First', 'THEIRS First');
    expect(clean(outcomeOf(BASE, BASE, theirs))).toBe(theirs);
    expect(clean(outcomeOf(BASE, theirs, BASE))).toBe(theirs);
  });

  it('compares blocks on their tree, so stale source bytes cannot decide', () => {
    const base = parsed(BASE, 'md');
    const ours = parsed(BASE, 'md');
    const theirs = parsed(replaced('First paragraph', 'THEIRS First paragraph'), 'md');
    const edited = ours.children[1];
    if (edited?.type !== 'paragraph') throw new Error('expected a paragraph');
    // An editor changes the tree and leaves the old source behind.
    const stale = {
      ...edited,
      children: [{ type: 'text' as const, value: 'An OURS rewrite here.' }],
    };
    const result = merge3(
      base,
      { ...ours, children: ours.children.map((block) => (block === edited ? stale : block)) },
      theirs,
    );
    if (!result.ok) throw new Error('refused');
    expect(result.value.kind).toBe('conflict');
    expect(rawOf(stale)).not.toBe(stale.source?.rawOf);
  });
});

describe('merge3 paths the outcome alone does not show', () => {
  const partialOf = (outcome: MergeOutcome) => {
    if (outcome.kind !== 'conflict') throw new Error('merged clean');
    return outcome.partial.children.map((block) => block.source?.raw);
  };
  const moved = 'Second paragraph with several other words here.';
  const movedDown = replaced(`${moved}\n\n`, '').replace('nicely.', `nicely.\n\n${moved}`);

  it('leaves ours on the page in a conflict, with theirs in the record', () => {
    const ours = replaced('several plain', 'several OURS');
    const theirs = replaced('several plain', 'several THEIRS');
    expect(partialOf(outcomeOf(BASE, ours, theirs))).toContain(
      'First paragraph with several OURS words here.',
    );
  });

  it('leaves the edit on the page when the other side deleted the block, either way', () => {
    const gone = replaced(`${moved}\n\n`, '');
    const edit = replaced('Second paragraph', 'Second EDIT paragraph');
    const raw = 'Second EDIT paragraph with several other words here.';
    expect(partialOf(outcomeOf(BASE, gone, edit))).toContain(raw);
    expect(partialOf(outcomeOf(BASE, edit, gone))).toContain(raw);
  });

  it('leaves ours in place at its slot when both move a block apart', () => {
    const theirs = `${moved}\n\n${replaced(`${moved}\n\n`, '')}`;
    const partial = partialOf(outcomeOf(BASE, movedDown, theirs));
    expect(partial[2]).toBe(moved);
    expect(partial.filter((raw) => raw === moved)).toHaveLength(1);
  });

  it('applies a one side change from whichever side made it', () => {
    const ours = replaced('First paragraph', 'OURS paragraph');
    expect(clean(outcomeOf(BASE, ours, BASE))).toBe(ours);
    expect(clean(outcomeOf(BASE, BASE, ours))).toBe(ours);
  });

  it('carries an edit to code along with a move, as nothing has to merge', () => {
    const code = '```\none line\ntwo line\nthree line\n```';
    const base = page('Above.', code, 'Middle.', 'Below.');
    const ours = page('Above.', 'Middle.', 'Below.', code);
    const theirs = page('Above.', code.replace('two', 'THEIRS'), 'Middle.', 'Below.');
    const expected = page('Above.', 'Middle.', 'Below.', code.replace('two', 'THEIRS'));
    expect(clean(outcomeOf(base, ours, theirs))).toBe(expected);
    expect(clean(outcomeOf(base, theirs, ours))).toBe(expected);
  });

  it('merges a move and edit from theirs with an edit from ours', () => {
    const ours = replaced('words here.\n\nThird', 'words OURS here.\n\nThird');
    const theirs = replaced(`${moved}\n\n`, '').replace('nicely.', `nicely.\n\nTHEIRS ${moved}`);
    expect(clean(outcomeOf(BASE, ours, theirs))).toContain(
      'THEIRS Second paragraph with several other words OURS here.',
    );
  });

  it('records ours and theirs in their own places when a moved and edited block conflicts', () => {
    const ours = replaced('several other', 'OURS other');
    const theirs = replaced(`${moved}\n\n`, '').replace(
      'nicely.',
      `nicely.\n\n${moved.replace('several', 'THEIRS')}`,
    );
    const [record] = conflicts(outcomeOf(BASE, ours, theirs));
    expect(record?.ours?.source?.raw).toContain('OURS');
    expect(record?.theirs?.source?.raw).toContain('THEIRS');
  });

  it('calls both sides moving a block to one spot an insert clash if anything else is there', () => {
    const ours = movedDown.replace(moved, `${moved}\n\nNew OURS block.`);
    const list = conflicts(outcomeOf(BASE, ours, movedDown));
    expect(list.map(({ reason }) => reason)).toEqual(['both_inserted']);
    const swapped = conflicts(outcomeOf(BASE, movedDown, ours));
    expect(swapped.map(({ reason }) => reason)).toEqual(['both_inserted']);
  });

  it('calls one block moved to one spot by both, with different edits, a conflict', () => {
    const ours = movedDown.replace('several', 'OURS');
    const theirs = movedDown.replace('several other', 'THEIRS other');
    const list = conflicts(outcomeOf(BASE, ours, theirs));
    expect(list.map(({ reason }) => reason)).toContain('move_vs_edit');
  });

  describe('a run of blocks moved away', () => {
    const blocks = ['Aaa aaa.', 'Bbb bbb.', 'Ccc ccc.', 'Ddd ddd.', 'Eee eee.', 'Fff fff.'];
    const [a, b, c, d, e, f] = blocks as [string, string, string, string, string, string];
    const base = page(...blocks);
    const ours = page(a, d, e, f, b, c);
    const places = (theirs: string) =>
      conflicts(outcomeOf(base, ours, theirs)).map(({ baseIndex, reason }) => [baseIndex, reason]);
    const both = [
      [1, 'move_vs_edit'],
      [2, 'move_vs_edit'],
    ];

    it('answers an insert above the run from every block in it', () => {
      expect(places(page(a, 'New.', b, c, d, e, f))).toEqual(both);
    });

    it('answers an insert below the run from every block in it', () => {
      expect(places(page(a, b, c, 'New.', d, e, f))).toEqual(both);
    });

    it('answers an insert inside the run from every block in it', () => {
      expect(places(page(a, b, 'New.', c, d, e, f))).toEqual(both);
    });

    it('stays clear of an insert past a block that stayed', () => {
      const theirs = page(a, b, c, d, 'New.', e, f);
      expect(clean(outcomeOf(base, ours, theirs))).toBe(page(a, d, 'New.', e, f, b, c));
    });
  });

  it('leaves an insert far from a moved block alone', () => {
    const blocks = ['Aaa aaa.', 'Bbb bbb.', 'Ccc ccc.', 'Ddd ddd.', 'Eee eee.'];
    const [a, b, c, d, e] = blocks as [string, string, string, string, string];
    const ours = page(c, a, b, d, e);
    const theirs = page(a, b, c, d, 'New THEIRS.', e);
    expect(clean(outcomeOf(page(...blocks), ours, theirs))).toBe(
      page(c, a, b, d, 'New THEIRS.', e),
    );
  });

  it('keeps inserts that differ in part apart, and a shared one once', () => {
    const edit = (text: string) => replaced('Second paragraph', `${text}\n\nSecond paragraph`);
    const list = conflicts(outcomeOf(BASE, edit('Aaa.\n\nBbb.'), edit('Aaa.\n\nCcc.')));
    expect(list.map(({ reason }) => reason)).toEqual(['both_inserted', 'both_inserted']);
  });

  it('puts conflicts in page order, with the top first', () => {
    const blocks = ['Aaa aaa.', 'Bbb bbb.', 'Ccc ccc.', 'Ddd ddd.', 'Eee eee.', 'Fff fff.'];
    const [a, , c, d, e, f] = blocks as [string, string, string, string, string, string];
    const ours = page('Top OURS.', a, 'Bbb OURS.', c, e, f, d);
    const theirs = page('Top THEIRS.', a, 'Bbb THEIRS.', c, f);
    const list = conflicts(outcomeOf(page(...blocks), ours, theirs));
    const places = list.map(({ baseIndex }) => baseIndex ?? -1);
    expect(list[0]?.baseIndex).toBeNull();
    expect(places).toEqual([...places].sort((left, right) => left - right));
  });

  it('answers a delete from both with a rewrite on either side', () => {
    const blocks = ['Keep this.', 'alpha beta gamma delta epsilon', 'Keep that.'];
    const [one, gone, two] = blocks as [string, string, string];
    const rewrite = 'alpha zeta eta theta iota kappa lambda';
    const base = page(one, gone, two);
    const deleted = page(one, two);
    const here = conflicts(outcomeOf(base, page(one, rewrite, two), deleted));
    const there = conflicts(outcomeOf(base, deleted, page(one, rewrite, two)));
    expect(here[0]?.ours?.source?.raw).toBe(rewrite);
    expect(here[0]?.theirs).toBeNull();
    expect(there[0]?.ours).toBeNull();
    expect(there[0]?.theirs?.source?.raw).toBe(rewrite);
  });

  it('calls a shared rewrite no conflict, and a rewrite of another kind no rewrite', () => {
    const base = page('Keep.', 'alpha beta gamma delta epsilon', 'Also.');
    const same = page('Keep.', 'alpha zeta eta theta iota kappa', 'Also.');
    expect(clean(outcomeOf(base, same, same))).toBe(same);
    const kind = page('Keep.', '# alpha zeta eta theta iota kappa', 'Also.');
    const deleted = page('Keep.', 'Also.');
    expect(clean(outcomeOf(base, kind, deleted))).toBe(kind);
    const unrelated = page('Keep.', 'nothing in common at all', 'Also.');
    expect(clean(outcomeOf(base, unrelated, deleted))).toBe(unrelated);
  });

  it('does not take a moved block for a rewrite of what both deleted', () => {
    const base = page('alpha beta', 'alpha gamma', 'Keep.', 'Also.');
    const ours = page('Keep.', 'alpha beta', 'Also.');
    const theirs = page('alpha beta', 'Keep.', 'Also.');
    expect(clean(outcomeOf(base, ours, theirs))).toBe(ours);
  });

  it('reads a block moved and edited as having taken in what both deleted', () => {
    const list = '+ word one more text\n+ word two more text\n+ word three more text';
    const base = page(list, 'word four more text', '    indented five', 'word six more text');
    const ours = page(list, 'word four more text', 'word six more text');
    const theirs = page(
      'word four more text extra',
      `${list}\n\n    indented five`,
      'word six more text',
    );
    const held = conflicts(outcomeOf(base, ours, theirs)).find(
      ({ reason }) => reason === 'delete_vs_edit',
    );
    expect(held?.baseIndex).toBe(2);
    expect(held?.theirs?.source?.raw).toContain('indented five');
  });

  it('does not read a moved block as having taken in what both deleted', () => {
    const big = 'alpha beta gamma delta';
    const base = page(big, 'alpha beta', 'Keep one.', 'Also two.', 'Last three.');
    const ours = page('Keep one.', 'Also two.', 'Last three.', big);
    const theirs = page(big, 'Keep one.', 'Also two.', 'Last three.');
    expect(clean(outcomeOf(base, ours, theirs))).toBe(ours);
  });

  it('resolves references against every definition on the page', () => {
    const base =
      'See [one][a] and [two][b] for more words.\n\n[a]: https://a.example\n\n[b]: https://b.example\n';
    const ours = base.replace('See', 'OURS');
    const theirs = base.replace('more words', 'more THEIRS');
    const outcome = outcomeOf(base, ours, theirs);
    if (outcome.kind !== 'clean') throw new Error('expected clean');
    const types = JSON.stringify(outcome.merged.children[0]).match(/linkReference/g);
    expect(types).toHaveLength(2);
  });

  it('finds no absorbed words in a block with none to find', () => {
    const base = page('Keep.', '---', 'Also more words.');
    const ours = page('Keep.', 'Also more words and more.');
    const theirs = page('Keep.', 'Also more words.');
    expect(clean(outcomeOf(base, ours, theirs))).toBe(ours);
  });

  it('answers a both sides delete when theirs took the words in', () => {
    const base = '    first code\n\n```\nmiddle\n```\n\n    second code\n\nWords.\n';
    const fused = '    second code\n\n    first code\n\n```\nmiddle\n```\n\nWords.\n';
    const deleted = '    first code\n\n```\nmiddle\n```\n\nWords.\n';
    const list = conflicts(outcomeOf(base, deleted, fused));
    const found = list.find(({ reason }) => reason === 'delete_vs_edit');
    expect(found?.theirs?.source?.raw).toContain('second code');
    expect(found?.ours).toBeNull();
  });
});

describe('merge3 items crossing blocks', () => {
  const lists =
    '- aaa\n- bbb\n\nMiddle plain words here.\n\n* ccc\n* ddd\n\nEnd plain words here.\n';
  const quotes =
    '> aaa\n>\n> bbb\n\nMiddle plain words here.\n\n> ccc\n>\n> ddd\n\nEnd plain words here.\n';
  const tables =
    '| h |\n| - |\n| aaa |\n| bbb |\n\nMiddle plain words here.\n\n| h |\n| - |\n| ccc |\n| ddd |\n\nEnd plain words here.\n';
  const reasons = (outcome: MergeOutcome) =>
    conflicts(outcome).map(({ baseIndex, reason }) => [baseIndex, reason]);

  it('raises a conflict when an item crosses lists past the other side edit', () => {
    const ours =
      '- aaa\n- bbb\n- ccc\n\nMiddle plain words here.\n\n* ddd\n\nEnd plain words here.\n';
    const theirs = lists.replace('plain', 'THEIRS');
    expect(reasons(outcomeOf(lists, ours, theirs))).toContainEqual([0, 'both_changed']);
    expect(reasons(outcomeOf(lists, theirs, ours))).toContainEqual([0, 'both_changed']);
  });

  it('raises a conflict for an item that went the other way', () => {
    const ours =
      '- aaa\n\nMiddle plain words here.\n\n* bbb\n* ccc\n* ddd\n\nEnd plain words here.\n';
    const theirs = lists.replace(
      'Middle plain words here.\n\n',
      'Middle plain words here.\n\nNew THEIRS.\n\n',
    );
    expect(reasons(outcomeOf(lists, ours, theirs))).toContainEqual([0, 'both_changed']);
  });

  it('raises a conflict when an item went into a new list', () => {
    const ours =
      '- aaa\n\nMiddle plain words here.\n\n+ bbb\n\n* ccc\n* ddd\n\nEnd plain words here.\n';
    const theirs = lists.replace('plain', 'THEIRS');
    expect(reasons(outcomeOf(lists, ours, theirs))).toContainEqual([0, 'both_changed']);
  });

  it('raises a conflict when a row crosses tables', () => {
    const ours = tables.replace('| bbb |\n', '').replace('| ccc |', '| bbb |\n| ccc |');
    const theirs = tables.replace('plain', 'THEIRS');
    expect(reasons(outcomeOf(tables, ours, theirs))).toContainEqual([0, 'both_changed']);
  });

  it('raises a conflict when a paragraph crosses quotes', () => {
    const ours = quotes.replace('> aaa\n>\n> bbb', '> aaa').replace('> ccc', '> bbb\n>\n> ccc');
    const theirs = quotes.replace('plain', 'THEIRS');
    expect(reasons(outcomeOf(quotes, ours, theirs))).toContainEqual([0, 'both_changed']);
  });

  it('lets a crossing stand when the other side stayed out of the span', () => {
    const ours =
      '- aaa\n- bbb\n- ccc\n\nMiddle plain words here.\n\n* ddd\n\nEnd plain words here.\n';
    const theirs = lists.replace('End', 'THEIRS');
    expect(clean(outcomeOf(lists, ours, theirs))).toBe(ours.replace('End', 'THEIRS'));
  });

  it('counts an item both lists held as crossing only out of those lists', () => {
    const base =
      '- aaa\n- same\n\nMiddle plain words here.\n\n* ccc\n* same\n\nEnd plain words here.\n';
    const ours =
      '- aaa\n- same\n- new\n\nMiddle plain words here.\n\n* ccc\n* same\n\nEnd plain words here.\n';
    const theirs = base.replace('plain', 'THEIRS');
    expect(clean(outcomeOf(base, ours, theirs))).toContain('THEIRS');
  });

  it('counts a side that changed nothing as staying out', () => {
    const ours =
      '- aaa\n- bbb\n- ccc\n\nMiddle plain words here.\n\n* ddd\n\nEnd plain words here.\n';
    expect(clean(outcomeOf(lists, ours, lists))).toBe(ours);
    expect(clean(outcomeOf(lists, lists, ours))).toBe(ours);
  });

  it('treats a list that took in a moved block as a rewrite only for a block it holds', () => {
    const base = '- item one\n\n> quote\n\n    code words\n\nEnd.\n';
    const theirs = '- item one\n\n    code words\n\nEnd.\n';
    const ours = base.replace('End.', 'End OURS.');
    expect(clean(outcomeOf(base, ours, theirs))).toContain('End OURS.');
  });

  it('raises one conflict for one span, however many items crossed it', () => {
    const ours =
      '- aaa\n- bbb\n- ccc\n- ddd\n\nMiddle plain words here.\n\nEnd plain words here.\n';
    const theirs = lists.replace('plain', 'THEIRS');
    const crossings = reasons(outcomeOf(lists, ours, theirs)).filter(
      ([, reason]) => reason === 'both_changed',
    );
    expect(crossings).toHaveLength(new Set(crossings.map(String)).size);
  });

  it('does not treat nested items as crossing', () => {
    const base = '- aaa\n\n  - bbb\n\nMiddle plain words here.\n';
    const ours = '- aaa OURS\n\n  - bbb\n\nMiddle plain words here.\n';
    const theirs = '- aaa\n\n  - bbb THEIRS\n\nMiddle plain words here.\n';
    expect(clean(outcomeOf(base, ours, theirs))).toBe(
      '- aaa OURS\n\n  - bbb THEIRS\n\nMiddle plain words here.\n',
    );
  });
});

describe('merge3 gaps and tails', () => {
  it('keeps a kept gap with spaces on the blank line', () => {
    const base = 'One.\n  \nTwo.\n\nThree.\n';
    const ours = 'New.\n\nOne.\n  \nTwo.\n\nThree.\n';
    const theirs = 'One.\n  \nThree.\n';
    expect(clean(outcomeOf(base, ours, theirs))).toBe('New.\n\nOne.\n  \nThree.\n');
  });

  it('opens a gap of one line in a CRLF file with a CRLF blank line', () => {
    const base = '# Title\r\nTight.\r\n\r\nOther block.\r\n';
    const ours = '# Title\r\nTight.\r\n\r\nOther OURS.\r\n';
    const theirs = '# Changed\r\n\r\n# Title\r\nTight.\r\n\r\nOther block.\r\n';
    const moved = 'Above.\r\n\r\n# Title\r\nTight.\r\n';
    expect(clean(outcomeOf(base, ours, theirs))).toContain('Other OURS.\r\n');
    const text = clean(outcomeOf(base, moved, base.replace('# Title\r\n', '')));
    expect(text).toContain('\r\n\r\nTight.');
  });

  it('keeps a kept gap that holds a blank line in old Mac endings', () => {
    const base = 'One.\r\rTwo.\n\nThree.\n';
    const ours = 'One.\r\rThree.\n';
    expect(parsed(base, 'md').children).toHaveLength(3);
    const theirs = base.replace('Two.', 'New.\n\nTwo.');
    expect(clean(outcomeOf(base, ours, theirs))).toContain('New.');
  });

  it.each([
    ['a blank line', '\n\n'],
    ['spaces on it', '\n  \n'],
    ['one tab on it', '\n\t\n'],
    ['CRLF', '\r\n\r\n'],
    ['old Mac endings', '\r\r'],
  ])('keeps a gap with %s when the block above it goes', (_name, gap) => {
    const base = `One.${gap}Two.${gap}Three.\n`;
    const root = parsed(base, 'md');
    const result = merge3(root, withoutMiddle(root), root);
    if (!result.ok || result.value.kind !== 'clean') throw new Error('expected clean');
    expect(printed(result.value.merged)).toBe(`One.${gap}Three.\n`);
  });

  it('opens a tight gap in a CRLF file, where one ending is not a blank line', () => {
    const base = 'Quote words.\r\n\r\n# Title\r\nTight words here.\r\n';
    const root = parsed(base, 'md');
    const result = merge3(root, withoutMiddle(root), root);
    if (!result.ok || result.value.kind !== 'clean') throw new Error('expected clean');
    expect(printed(result.value.merged)).toBe('Quote words.\r\n\r\nTight words here.\r\n');
  });

  it('opens a tight gap when the block above it goes', () => {
    const base = 'One.\n\n# Two\nThree.\n';
    const root = parsed(base, 'md');
    const result = merge3(root, withoutMiddle(root), root);
    if (!result.ok || result.value.kind !== 'clean') throw new Error('expected clean');
    expect(printed(result.value.merged)).toBe('One.\n\nThree.\n');
  });

  it('drops the gap of a block a delete left on top', () => {
    const root = parsed('# Title\n\nWords.\n\nMore.\n', 'md');
    const ours = { ...root, children: root.children.slice(1) };
    const result = merge3(root, ours, root);
    if (!result.ok || result.value.kind !== 'clean') throw new Error('expected clean');
    expect(printed(result.value.merged)).toBe('Words.\n\nMore.\n');
  });

  it('holds a block that was first in its place on the first line', () => {
    const base = '\n\n# Title\n\nWords.\n';
    expect(clean(outcomeOf(base, base, base.replace('Words', 'THEIRS')))).toBe(
      '\n\n# Title\n\nTHEIRS.\n',
    );
  });

  it('prints a new block on top with no gap', () => {
    const base = 'Words.\n\nMore.\n';
    const ours = parsed(base, 'md');
    const added = {
      type: 'paragraph' as const,
      children: [{ type: 'text' as const, value: 'New.' }],
    };
    const inserted = { ...ours, children: [added, ...ours.children] };
    const result = merge3(parsed(base, 'md'), inserted, parsed(base, 'md'));
    if (!result.ok || result.value.kind !== 'clean') throw new Error('expected clean');
    expect(printed(result.value.merged)).toBe('New.\n\nWords.\n\nMore.\n');
  });

  it('leaves a new block in the middle with no source', () => {
    const base = 'Words.\n\nMore words here.\n';
    const root = parsed(base, 'md');
    const added = {
      type: 'paragraph' as const,
      children: [{ type: 'text' as const, value: 'New.' }],
    };
    const inserted = {
      ...root,
      children: [...root.children.slice(0, 1), added, ...root.children.slice(1)],
    };
    const result = merge3(root, inserted, parsed(base.replace('More', 'Other'), 'md'));
    if (!result.ok || result.value.kind !== 'clean') throw new Error('expected clean');
    expect(result.value.merged.children[1]).toEqual(added);
  });

  it('picks the same tail whichever side comes first when both changed it', () => {
    const base = 'One.\n';
    const left = 'One.\n\n';
    const right = 'One.\n\n\n';
    expect(clean(outcomeOf(base, left, right))).toBe(left);
    expect(clean(outcomeOf(base, right, left))).toBe(left);
  });

  it('keeps the tail hash with its tail', () => {
    const outcome = outcomeOf('One.\n', 'One.\n\n', 'One.\n');
    expect(outcome.kind === 'clean' && printed(outcome.merged)).toBe('One.\n\n');
    const swapped = outcomeOf('One.\n', 'One.\n\n\n', 'One.\n\n');
    expect(swapped.kind === 'clean' && printed(swapped.merged)).toBe('One.\n\n');
  });
});

describe('merge3 limits', () => {
  // Pages this large took 6 s and 32 s under coverage on a CI runner, most of it parsing the fixture.
  const LARGE_PAGE_TIMEOUT_MS = 90_000;

  const pageOf = (blocks: number) =>
    Array.from({ length: blocks }, (_, index) => `Block ${index}.`).join('\n\n');
  const refusal = { code: 'mdx.merge_limit', severity: 'error', line: 1, column: 1 };

  it('takes a page at the limit and refuses one past it, on any side', () => {
    const at = parsed(`${pageOf(4)}\n`, 'md');
    const past = parsed(`${pageOf(5)}\n`, 'md');
    const limit = { maxBlocks: 4 };
    expect(merge3(at, at, at, limit).ok).toBe(true);
    expect(merge3(past, at, at, limit)).toEqual({ ok: false, error: [refusal] });
    expect(merge3(at, past, at, limit)).toEqual({ ok: false, error: [refusal] });
    expect(merge3(at, at, past, limit)).toEqual({ ok: false, error: [refusal] });
  });

  it(
    'defaults to 20000 blocks',
    () => {
      expect(DEFAULT_MERGE_MAX_BLOCKS).toBe(20_000);
      const block = { type: 'thematicBreak' as const };
      const root = (blocks: number): MdxRoot => ({
        ...parsed('', 'md'),
        children: Array.from({ length: blocks }, () => block),
      });
      expect(merge3(root(20_000), root(20_000), root(20_000)).ok).toBe(true);
      expect(merge3(root(20_001), root(20_000), root(20_000))).toEqual({
        ok: false,
        error: [refusal],
      });
    },
    LARGE_PAGE_TIMEOUT_MS,
  );

  it('refuses a tree past the node limit in its policy', () => {
    const at = parsed(`${pageOf(4)}\n`, 'md');
    const policy = { ...isolatedPolicy(), limits: { ...isolatedPolicy().limits, maxNodes: 3 } };
    expect(merge3(at, at, at, { policy })).toEqual({ ok: false, error: [refusal] });
  });

  it(
    'merges a page rewritten end to end on both sides without a quadratic table',
    () => {
      const blocks = 3_000;
      const side = (word: string) =>
        Array.from({ length: blocks }, (_, index) => `${word} ${index} q${index * 7}.`).join(
          '\n\n',
        );
      const outcome = outcomeOf(`${pageOf(blocks)}\n`, `${side('ours')}\n`, `${side('theirs')}\n`);
      expect(outcome.kind).toBe('conflict');
    },
    LARGE_PAGE_TIMEOUT_MS,
  );
});

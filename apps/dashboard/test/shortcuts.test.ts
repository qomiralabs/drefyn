import { describe, expect, it } from 'vitest';
import { sequenceTarget } from '../src/shell/keys.ts';
import {
  keyLabel,
  sequences,
  sheetGroups,
  SHORTCUTS,
  singleKeysOn,
  spoken,
  type Shortcut,
} from '../src/shell/shortcuts.ts';

// Built from code points, so this file holds no dash of its own.
const DASHES = new RegExp(`[${String.fromCodePoint(0x2013, 0x2014)}]`);

describe('the shortcuts sheet', () => {
  it('lists every registered shortcut exactly once', () => {
    for (const apple of [true, false]) {
      const listed = sheetGroups(SHORTCUTS, apple).flatMap((g) => g.rows.map((r) => r.id));
      expect([...listed].sort()).toEqual(SHORTCUTS.map((s) => s.id).sort());
    }
  });

  it('lists a shortcut added to the registry, with no change to the sheet', () => {
    const extra: Shortcut = { id: 'extra', keys: [['[']], does: 'Fold the sidebar', single: true };
    const rows = sheetGroups([...SHORTCUTS, extra], false).flatMap((g) => g.rows);
    expect(rows.find((r) => r.id === 'extra')).toEqual({
      id: 'extra',
      does: 'Fold the sidebar',
      keys: [['[']],
      spoken: '[',
    });
  });

  it('puts the single keys, the ones the switch turns off, in their own group', () => {
    const [anywhere, single] = sheetGroups(SHORTCUTS, false);
    expect(anywhere?.title).toBe('Anywhere');
    expect(single?.title).toBe('Single keys');
    const singles = SHORTCUTS.filter((s) => s.single).map((s) => s.id);
    expect(single?.rows.map((r) => r.id)).toEqual(singles);
    expect(anywhere?.rows.every((r) => !singles.includes(r.id))).toBe(true);
  });

  it('draws Mod as the Command sign on Apple devices and Ctrl elsewhere, and says it in words', () => {
    expect(keyLabel('Mod', true)).toBe('⌘');
    expect(keyLabel('Mod', false)).toBe('Ctrl');
    expect(keyLabel('G', true)).toBe('G');
    expect(spoken([['Mod', 'K']], true)).toBe('Command plus K');
    expect(spoken([['Mod', 'K']], false)).toBe('Control plus K');
    expect(spoken([['G'], ['1']], false)).toBe('G then 1');
  });

  it('says what each shortcut does in plain words with no dashes', () => {
    for (const s of SHORTCUTS) {
      expect(s.does.trim(), s.id).not.toBe('');
      expect(s.does, s.id).not.toMatch(DASHES);
    }
    expect(new Set(SHORTCUTS.map((s) => s.id)).size).toBe(SHORTCUTS.length);
  });
});

describe('G sequences come from the registry', () => {
  it('maps each second key to its place', () => {
    expect(sequences(SHORTCUTS)).toEqual({
      '1': 'docs',
      '2': 'studio',
      '3': 'status',
      o: 'overview',
    });
  });

  it('is what the key handler follows, so the sheet and the keys agree', () => {
    for (const s of SHORTCUTS.filter((x) => x.target !== undefined)) {
      const second = s.keys[1]?.[0]?.toLowerCase() ?? '';
      expect(sequenceTarget({ key: 'g', at: 0 }, second, 10), s.id).toBe(s.target);
    }
  });

  it('skips entries that are not G sequences', () => {
    expect(
      sequences([
        { id: 'a', keys: [['?']], does: 'x', single: true, target: 'docs' },
        { id: 'b', keys: [['H'], ['1']], does: 'x', single: true, target: 'docs' },
        { id: 'c', keys: [['G']], does: 'x', single: true, target: 'docs' },
      ]),
    ).toEqual({});
  });
});

describe('the single keys switch', () => {
  it('is on unless turned off', () => {
    expect(singleKeysOn(() => null)).toBe(true);
    expect(singleKeysOn(() => 'on')).toBe(true);
    expect(singleKeysOn(() => 'off')).toBe(false);
  });

  it('stays on when storage refuses to answer', () => {
    expect(
      singleKeysOn(() => {
        throw new Error('denied');
      }),
    ).toBe(true);
  });
});

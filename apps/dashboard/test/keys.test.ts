import { describe, expect, it } from 'vitest';
import { isTyping, SEQUENCE_WINDOW_MS, sequenceTarget } from '../src/shell/keys.ts';

const el = (tagName: string, attrs: Record<string, string> = {}, editable = false) =>
  ({
    tagName,
    isContentEditable: editable,
    getAttribute: (name: string) => attrs[name] ?? null,
  }) as unknown as Element;

describe('isTyping', () => {
  it.each([
    ['a text input', el('INPUT')],
    ['a search input', el('INPUT', { type: 'search' })],
    ['a textarea', el('TEXTAREA')],
    ['a select', el('SELECT')],
    ['an editable region', el('DIV', {}, true)],
  ])('is true in %s', (_label, target) => {
    expect(isTyping(target)).toBe(true);
  });

  it.each([
    ['nothing focused', null],
    ['a button', el('BUTTON')],
    ['a checkbox', el('INPUT', { type: 'checkbox' })],
    ['a link', el('A')],
  ])('is false with %s', (_label, target) => {
    expect(isTyping(target)).toBe(false);
  });
});

describe('sequenceTarget', () => {
  const g = { key: 'g', at: 1000 };

  it('maps G then 1, 2, 3 and O to the products and the overview', () => {
    expect(['1', '2', '3', 'o'].map((k) => sequenceTarget(g, k, 1200))).toEqual([
      'docs',
      'studio',
      'status',
      'overview',
    ]);
  });

  it('needs G first and the second key within the window', () => {
    expect(sequenceTarget(null, '3', 1200)).toBeNull();
    expect(sequenceTarget({ key: 'x', at: 1000 }, '3', 1200)).toBeNull();
    expect(sequenceTarget(g, '3', 1000 + SEQUENCE_WINDOW_MS + 1)).toBeNull();
    expect(sequenceTarget(g, '3', 1000 + SEQUENCE_WINDOW_MS)).toBe('status');
    expect(sequenceTarget(g, '9', 1200)).toBeNull();
  });
});

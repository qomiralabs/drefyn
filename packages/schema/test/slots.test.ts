import { describe, expect, it } from 'vitest';
import { FILTER_SLOTS, MAX_FILTER_FIELDS, slotClassOf, type FieldDef } from '../src/index.ts';
import {
  asset,
  bool,
  date,
  list,
  markdown,
  number,
  object,
  reference,
  richText,
  text,
  tid,
} from './support.ts';

describe('filter slots', () => {
  it('sums to twelve: five text, five integer, two time', () => {
    expect(FILTER_SLOTS).toEqual({ text: 5, integer: 5, time: 2 });
    expect(MAX_FILTER_FIELDS).toBe(12);
  });

  it.each<[string, FieldDef, string | null]>([
    ['short text', text(1, {}, 256), 'text'],
    ['long text', text(1, {}, 257), null],
    ['number', number(1), 'integer'],
    ['boolean', bool(1), 'integer'],
    ['date', date(1), 'time'],
    ['single reference', reference(1), 'text'],
    ['many reference', reference(1, [tid(1)], {}, true), null],
    ['short list', list(1, text(2, {}, 32), {}, 32), 'text'],
    ['rich text', richText(1), null],
    ['Markdown', markdown(1), null],
    ['asset', asset(1), null],
    ['object', object(1, [text(2)]), null],
  ])('%s', (_name, field, slot) => {
    expect(slotClassOf(field)).toBe(slot);
  });
});

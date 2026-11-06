import type { ContentSchema, FieldDef, FieldId, TypeId } from '@drefyn/schema';
import { describe, expect, it } from 'vitest';
import { assignSlots, parseSlotMap, slotRowOf, type SlotMap } from '../src/filter-slots.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as FieldId;

const text = (n: number, maxLength = 40): FieldDef => ({
  id: id(n),
  apiName: `text${String(n)}`,
  label: 'Text',
  required: false,
  filterable: true,
  kind: 'text',
  maxLength,
});
const count = (n: number): FieldDef => ({
  id: id(n),
  apiName: `count${String(n)}`,
  label: 'Count',
  required: false,
  sortable: true,
  kind: 'number',
  scale: 0,
});
const flag = (n: number): FieldDef => ({
  id: id(n),
  apiName: `flag${String(n)}`,
  label: 'Flag',
  required: false,
  filterable: true,
  kind: 'boolean',
});
const when = (n: number): FieldDef => ({
  id: id(n),
  apiName: `when${String(n)}`,
  label: 'When',
  required: false,
  filterable: true,
  kind: 'date',
  withTime: true,
});
const tags = (n: number, maxItems = 32, maxLength = 32): FieldDef => ({
  id: id(n),
  apiName: `tags${String(n)}`,
  label: 'Tags',
  required: false,
  filterable: true,
  kind: 'list',
  maxItems,
  of: { id: id(n + 1000), apiName: 'tag', label: 'Tag', required: false, kind: 'text', maxLength },
});
const plain = (n: number): FieldDef => ({
  id: id(n),
  apiName: `plain${String(n)}`,
  label: 'Plain',
  required: false,
  kind: 'text',
  maxLength: 100_000,
});

const schemaOf = (fields: readonly FieldDef[], version = 1): ContentSchema => ({
  typeId: id(9000) as string as TypeId,
  apiName: 'item',
  version,
  fields,
  deprecated: [],
  retired: [],
});

const assigned = (schema: ContentSchema, prior: SlotMap = {}, hasItems = false) => {
  const result = assignSlots(schema, prior, hasItems);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
};

describe('assignSlots', () => {
  it('gives each declared field a column of its class and skips the rest', () => {
    const { slots } = assigned(schemaOf([text(1), count(2), flag(3), when(4), tags(5), plain(6)]));
    expect(slots[id(1)]).toEqual({ column: 't1', state: 'ready' });
    expect(slots[id(2)]).toEqual({ column: 'i1', state: 'ready' });
    expect(slots[id(3)]).toEqual({ column: 'i2', state: 'ready' });
    expect(slots[id(4)]).toEqual({ column: 'd1', state: 'ready' });
    expect(slots[id(5)]).toEqual({ column: 'l2', state: 'ready' });
    expect(slots[id(6)]).toBeUndefined();
  });

  it('keeps a slot for life across schema versions, whatever the field order', () => {
    const first = assigned(schemaOf([text(1), text(2), count(3)])).slots;
    const next = assigned(schemaOf([text(9), count(3), text(2), text(1)], 2), first).slots;
    expect(next[id(1)]).toEqual(first[id(1)]);
    expect(next[id(2)]).toEqual(first[id(2)]);
    expect(next[id(3)]).toEqual(first[id(3)]);
    expect(next[id(9)]?.column).toBe('t3');
  });

  it('a list and a text field never share a slot number', () => {
    const first = assigned(schemaOf([tags(1, 4, 8), text(2)])).slots;
    expect(first[id(1)]?.column).toBe('l1');
    expect(first[id(2)]?.column).toBe('t2');
  });

  it('starts a fill for a new field on a type that has items, and only then', () => {
    const prior = assigned(schemaOf([text(1)])).slots;
    const empty = assigned(schemaOf([text(1), text(2)], 2), prior, false);
    expect(empty.fills).toEqual([]);
    expect(empty.slots[id(2)]?.state).toBe('ready');
    const full = assigned(schemaOf([text(1), text(2)], 2), prior, true);
    expect(full.fills).toEqual([{ fieldId: id(2), column: 't2' }]);
    expect(full.slots[id(2)]?.state).toBe('backfilling');
    expect(full.slots[id(1)]?.state).toBe('ready');
  });

  it('clears the slot of a removed field before anything can reuse it', () => {
    const prior = assigned(schemaOf([text(1), text(2)])).slots;
    const next = assigned(schemaOf([text(2)], 2), prior, true);
    expect(next.clears).toEqual([{ fieldId: id(1), column: 't1' }]);
    expect(next.slots[id(1)]).toEqual({ column: 't1', state: 'clearing' });

    const taken = assigned(schemaOf([text(2), text(3)], 3), next.slots, true);
    expect(taken.slots[id(3)]?.column).toBe('t3');
  });

  it('frees the slot of a removed field at once on an empty type', () => {
    const prior = assigned(schemaOf([text(1)])).slots;
    const next = assigned(schemaOf([], 2), prior, false);
    expect(next.slots).toEqual({});
    expect(next.clears).toEqual([]);
  });

  it('refuses a new field while the only free slot is still being cleared', () => {
    const five = [1, 2, 3, 4, 5].map((n) => text(n));
    const prior = assigned(schemaOf(five)).slots;
    const cleared = assigned(schemaOf(five.slice(1), 2), prior, true).slots;
    const result = assignSlots(schemaOf([...five.slice(1), text(6)], 3), cleared, true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('engine.filter_slot_busy');
  });

  it('allows the widest row the evidence fits: four long texts and one full list', () => {
    const fields = [text(1, 256), text(2, 256), text(3, 256), text(4, 256), tags(5)];
    expect(assignSlots(schemaOf(fields), {}, false).ok).toBe(true);
  });

  it('refuses a definition whose row could pass the index tuple limit, before any save', () => {
    const fields = [text(1, 256), text(2, 256), text(3, 256), tags(4), tags(5)];
    const result = assignSlots(schemaOf(fields), {}, false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('engine.filter_row_too_wide');
  });
});

describe('parseSlotMap', () => {
  it('reads what assignSlots wrote', () => {
    const { slots } = assigned(schemaOf([text(1), tags(2, 4, 8)]));
    expect(parseSlotMap(JSON.parse(JSON.stringify(slots)))).toEqual(slots);
  });

  it.each([
    [{ x: { column: 't1', state: 'ready' } }],
    [{ [id(1)]: { column: 't9', state: 'ready' } }],
    [{ [id(1)]: { column: 't1; drop table app.nodes', state: 'ready' } }],
    [{ [id(1)]: { column: 't1', state: 'other' } }],
    [[]],
  ])('refuses a stored map that is not one of ours: %j', (stored) => {
    expect(() => parseSlotMap(stored)).toThrow();
  });
});

describe('slotRowOf', () => {
  const slots = assigned(schemaOf([text(1), count(2), flag(3), when(4), tags(5, 4, 8)])).slots;

  it('fills every column, so a removed value cannot linger', () => {
    const row = slotRowOf(slots, { [id(1)]: 'a', [id(2)]: '12' });
    expect(Object.keys(row)).toHaveLength(17);
    expect(row.t1).toBe('a');
    expect(row.i1).toBe('12');
    expect(row.i2).toBeNull();
    expect(row.l2).toBeNull();
  });

  it('turns a boolean into 0 or 1 and leaves a list as a list', () => {
    const row = slotRowOf(slots, {
      [id(3)]: false,
      [id(4)]: '2026-01-02T03:04:05.000Z',
      [id(5)]: ['a', 'b'],
    });
    expect(row.i2).toBe('0');
    expect(row.d1).toBe('2026-01-02T03:04:05.000Z');
    expect(row.l2).toEqual(['a', 'b']);
    expect(slotRowOf(slots, { [id(3)]: true }).i2).toBe('1');
  });

  it('writes nothing to a slot that is being cleared', () => {
    const row = slotRowOf({ [id(1)]: { column: 't1', state: 'clearing' } }, { [id(1)]: 'a' });
    expect(row.t1).toBeNull();
  });

  it('ignores a value with no slot', () => {
    expect(slotRowOf(slots, { [id(77)]: 'a' }).t1).toBeNull();
  });
});

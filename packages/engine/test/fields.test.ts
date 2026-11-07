import type { ContentSchema, FieldDef, FieldId, TypeId } from '@drefyn/schema';
import { describe, expect, it } from 'vitest';
import { canonicalFields, canonicalValue, filterValue } from '../src/fields.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as FieldId;
const base = (n: number) => ({ id: id(n), apiName: `f${String(n)}`, label: 'F', required: false });

const FIELDS: readonly FieldDef[] = [
  { ...base(1), kind: 'text', maxLength: 8 },
  { ...base(2), kind: 'number', scale: 2, min: '0', max: '100' },
  { ...base(3), kind: 'boolean' },
  { ...base(4), kind: 'date', withTime: true },
  { ...base(5), kind: 'date', withTime: false },
  { ...base(6), kind: 'reference', to: [], many: false },
  { ...base(7), kind: 'reference', to: [], many: true },
  {
    ...base(8),
    kind: 'list',
    maxItems: 3,
    of: { ...base(108), kind: 'text', maxLength: 4 },
  },
  { ...base(9), kind: 'markdown', maxLength: 16 },
  { ...base(10), kind: 'rich_text' },
  { ...base(11), kind: 'list', maxItems: 2, of: { ...base(111), kind: 'number', scale: 0 } },
];

const schema: ContentSchema = {
  typeId: id(9000) as string as TypeId,
  apiName: 'item',
  version: 1,
  fields: FIELDS,
  deprecated: [],
  retired: [],
};

const refused = (fields: Record<string, unknown>) => {
  const result = canonicalFields(schema, fields, 4096);
  if (result.ok) throw new Error('expected a refusal');
  return result.error;
};

describe('canonicalFields', () => {
  it('stores numbers as integer units, so no float can be read back', () => {
    const result = canonicalFields(schema, { [id(2)]: '12.50' }, 4096);
    expect(result).toEqual({ ok: true, value: { [id(2)]: '1250' } });
  });

  it('stores dates as UTC instants', () => {
    const result = canonicalFields(
      schema,
      { [id(4)]: '2026-01-01T01:00:00+01:00', [id(5)]: '2026-02-03' },
      4096,
    );
    expect(result).toEqual({
      ok: true,
      value: { [id(4)]: '2026-01-01T00:00:00.000Z', [id(5)]: '2026-02-03T00:00:00.000Z' },
    });
  });

  it('drops an empty list, so exists means the same on a slot and in a scan', () => {
    expect(canonicalFields(schema, { [id(8)]: [] }, 4096)).toEqual({ ok: true, value: {} });
  });

  it('gives the same bytes for the same values in any key order', () => {
    const one = canonicalFields(schema, { [id(1)]: 'a', [id(3)]: true }, 4096);
    const two = canonicalFields(schema, { [id(3)]: true, [id(1)]: 'a' }, 4096);
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });

  it('keeps many references and lists of numbers in canonical form', () => {
    const ref = '018f0000-0000-7000-8000-000000000001';
    const result = canonicalFields(schema, { [id(7)]: [ref], [id(11)]: ['1', '2'] }, 4096);
    expect(result).toEqual({ ok: true, value: { [id(7)]: [ref], [id(11)]: ['1', '2'] } });
  });

  it('refuses a field the type does not have', () => {
    expect(refused({ [id(50)]: 'a' }).issues[0]).toEqual({
      path: `fields.${id(50)}`,
      code: 'engine.field_unknown',
    });
  });

  it('refuses a kind that lives in content', () => {
    expect(refused({ [id(10)]: 'a' }).issues[0]?.code).toBe('engine.field_not_stored');
  });

  it.each([
    ['too long in bytes', 1, 'ééééé'],
    ['a NUL', 1, 'a\u0000'],
    ['a lone surrogate', 1, '\ud800'],
    ['a float past the scale', 2, '1.123'],
    ['below min', 2, '-1'],
    ['above max', 2, '100.01'],
    ['a string for a boolean', 3, 'true'],
    ['a date with no offset', 4, '2026-01-01T00:00:00'],
    ['a date out of calendar', 5, '2026-02-31'],
    ['a year past the instant range', 4, '9999-12-31T23:59:59-01:00'],
    ['a time in year 0000', 4, '0000-06-01T00:00:00Z'],
    ['a shift into year 0000', 4, '0001-01-01T00:00:00+02:00'],
    ['a plain date in year 0000', 5, '0000-06-01'],
    ['not a uuid', 6, 'x'],
    ['a list for a single value', 1, ['a']],
    ['a single value for a list', 8, 'a'],
    ['a 4th item', 8, ['a', 'b', 'c', 'd']],
    ['an item too long', 8, ['abcde']],
  ])('refuses %s', (_name, n, value) => {
    expect(refused({ [id(n)]: value }).code).toBe('engine.validation_failed');
  });

  it('refuses the whole set past the byte budget', () => {
    const result = canonicalFields(schema, { [id(9)]: 'aaaaaaaaaaaaaaaa' }, 10);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('engine.too_large');
  });
});

describe('filterValue', () => {
  const field = (n: number) => {
    const found = FIELDS.find(({ id: fieldId }) => fieldId === id(n));
    if (found === undefined) throw new Error('no such field');
    return found;
  };

  it('takes text past what the field may store, which only matches nothing', () => {
    expect(filterValue(field(1), 'longer than eight')).toBe('longer than eight');
  });

  it.each([
    ['a lone surrogate in text', 1, '\ud800'],
    ['a lone surrogate in markdown', 9, 'a\udc00b'],
    ['a lone surrogate in a list of text', 8, '\ud800'],
    ['a NUL in text', 1, 'a\u0000'],
  ])('holds back %s, which Postgres would refuse', (_name, n, value) => {
    expect(filterValue(field(n), value)).toBeNull();
  });
});

describe('canonicalValue', () => {
  it('gives a filter the same form a save stores', () => {
    const number = FIELDS[1];
    if (number === undefined) throw new Error('no field');
    expect(canonicalValue(number, '1.5')).toBe('150');
  });
});

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  asFieldId,
  asTypeId,
  MAX_FIELDS,
  MAX_RETIRED_FIELDS,
  parseContentSchema,
  validateSchema,
} from '../src/index.ts';
import { asset, fid, number, object, schema, text } from './support.ts';

const LABEL_UNIT = fc.constantFrom('a', '\u00e9', '\u4e2d', '\u{1f600}', '\0', '\ud83d', '\ude00');

const code = (input: unknown) => {
  const result = parseContentSchema(input);
  return result.ok ? null : result.error.code;
};

const json = (input: unknown): unknown => JSON.parse(JSON.stringify(input));

function deepArrays(depth: number): unknown {
  let value: unknown = [];
  for (let i = 0; i < depth; i += 1) value = [value];
  return value;
}

describe('ids', () => {
  it('takes a canonical uuid and nothing else', () => {
    const good = '00000000-0000-7000-8000-000000000001';
    expect(asFieldId(good)).toBe(good);
    expect(asTypeId(good)).toBe(good);
    expect(asFieldId(good.toUpperCase().replace('0000-7', '0000-A'))).toBeUndefined();
    expect(asFieldId(`${good}\n`)).toBeUndefined();
    expect(asFieldId('title')).toBeUndefined();
    expect(asTypeId('')).toBeUndefined();
  });
});

describe('parseContentSchema', () => {
  it('round trips a schema through JSON', () => {
    const input = schema([text(1), number(2), object(3, [text(4)])]);
    const result = parseContentSchema(json(input));
    expect(result).toEqual({ ok: true, value: input });
  });

  it('returns keys in one order, whatever order they arrived in', () => {
    const input = json(schema([text(1)])) as Record<string, unknown>;
    const shuffled = Object.fromEntries(Object.entries(input).reverse());
    const a = parseContentSchema(input);
    const b = parseContentSchema(shuffled);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['a string', 'schema'],
    ['an array', []],
    ['no fields', schema([])],
    ['an empty object field', schema([object(1, [])])],
    ['no retired list', { ...schema([text(1)]), retired: undefined }],
    ['an empty label', schema([text(1, { label: '' })])],
    ['a free text id', schema([{ ...text(1), id: "x'; drop" } as never])],
    ['an unknown kind', schema([{ ...text(1), kind: 'money' } as never])],
    ['a float length', schema([text(1, {}, 1.5)])],
    ['a zero length', schema([text(1, {}, 0)])],
    ['a fractional version', schema([text(1)], { version: 1.5 })],
    ['a bad media type', schema([{ ...asset(1), accept: ['image/png; x=1'] } as never])],
    ['no media types', schema([{ ...asset(1), accept: [] } as never])],
    ['an unknown text format', schema([{ ...text(1), format: 'html' } as never])],
  ])('refuses %s', (_name, input) => {
    expect(code(input)).toBe('schema.malformed');
  });

  // jsonb refuses both, so one that got this far would come back as a raw database error.
  it.each([
    ['a NUL', 'a\0b'],
    ['a lone high surrogate', '\ud800'],
    ['a lone low surrogate', 'a\udc00b'],
  ])('refuses a label holding %s, at any depth', (_name, label) => {
    const hostile = { ...text(2), label };
    const list = { ...text(1), kind: 'list', of: hostile, maxItems: 4 };
    expect(code(schema([hostile]))).toBe('schema.malformed');
    expect(code(schema([object(1, [hostile])]))).toBe('schema.malformed');
    expect(code(schema([list as never]))).toBe('schema.malformed');
    expect(parseContentSchema(schema([hostile]))).toMatchObject({
      ok: false,
      error: { issues: [{ path: 'fields.0.label', code: 'schema.malformed' }] },
    });
  });

  it('keeps a label jsonb can hold, whatever else it contains', () => {
    fc.assert(
      fc.property(fc.string({ unit: LABEL_UNIT, minLength: 1 }), (label) => {
        // A lone surrogate does not survive UTF-8, and two units can still pair up as one.
        const held = !label.includes('\0') && Buffer.from(label).toString() === label;
        expect(code(schema([{ ...text(1), label }]))).toBe(held ? null : 'schema.malformed');
      }),
    );
  });

  it('refuses unknown keys, including an own __proto__ key from JSON', () => {
    const polluted = JSON.parse(
      `{"typeId":"00000000-0000-7000-9000-000000000001","apiName":"A","version":1,"deprecated":[],"retired":[],
        "fields":[{"id":"${fid(1)}","apiName":"a","label":"a","required":false,"kind":"boolean",
        "__proto__":{"polluted":true}}]}`,
    ) as unknown;
    expect(code(polluted)).toBe('schema.malformed');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(code({ ...schema([text(1)]), extra: true })).toBe('schema.malformed');
  });

  it('refuses a hostile depth without running out of stack', () => {
    expect(code(deepArrays(500_000))).toBe('schema.too_deep');
    expect(code({ ...schema([text(1)]), fields: deepArrays(500_000) })).toBe('schema.too_deep');
  });

  it('refuses a cycle', () => {
    const field: Record<string, unknown> = { ...text(1), kind: 'object' };
    field['fields'] = [field];
    expect(code(schema([field as never]))).toBe('schema.too_deep');
  });

  it('refuses a huge wide input before validating it', () => {
    expect(code(new Array(5_000_000).fill(0))).toBe('schema.too_large');
    expect(code(new Array(2 ** 32 - 1))).toBe('schema.too_large');
    expect(code(Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`k${i}`, i])))).toBe(
      'schema.too_large',
    );
    expect(code({ ...schema([text(1)]), apiName: 'x'.repeat(2_000_000) })).toBe('schema.too_large');
  });

  it('lets the largest legal schema past the raw budget', () => {
    const fields = Array.from({ length: MAX_FIELDS }, (_, i) => ({
      ...asset(i + 1, { localized: true, unique: false, filterable: false, sortable: false }),
      accept: Array.from({ length: 32 }, (_x, j) => `image/x${j}`),
    }));
    const retired = Array.from({ length: MAX_RETIRED_FIELDS }, (_, i) => fid(i + 1_000));
    const largest = schema(fields, { deprecated: fields.map((f) => f.id), retired });
    expect(code(json(largest))).toBeNull();
  });

  it('never repeats input text in an error', () => {
    const secret = 'person@example.com';
    const inputs = [
      { typeId: secret },
      { ...schema([text(1)]), [secret]: secret },
      schema([{ ...text(1), apiName: secret, kind: secret } as never]),
    ];
    for (const input of inputs) {
      expect(JSON.stringify(parseContentSchema(input))).not.toContain(secret);
    }
    const named = validateSchema(schema([text(1, { apiName: secret, label: secret })]), null);
    expect(JSON.stringify(named)).not.toContain(secret);
  });
});

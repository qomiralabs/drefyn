import { describe, expect, it } from 'vitest';
import {
  MAX_FIELD_DEPTH,
  MAX_FIELDS,
  MAX_LABEL_LENGTH,
  MAX_REFERENCE_TARGETS,
  MAX_RETIRED_FIELDS,
  MAX_TEXT_BYTES,
  SCHEMA_ERROR_CODES,
  validateSchema,
  type FieldDef,
  type SchemaErrorCode,
} from '../src/index.ts';
import {
  asset,
  bool,
  date,
  fid,
  list,
  markdown,
  next,
  number,
  object,
  reference,
  richText,
  schema,
  text,
  tid,
} from './support.ts';

const codes = (input: unknown, prior: Parameters<typeof validateSchema>[1] = null) => {
  const result = validateSchema(input as never, prior);
  return result.ok ? [] : result.error.issues.map((issue) => issue.code);
};

const nested = (depth: number, n = 1): FieldDef =>
  depth === 1 ? text(n) : object(n, [nested(depth - 1, n + 1)]);

describe('every SchemaErrorCode', () => {
  const unit = schema([text(1)]);
  const table: Record<SchemaErrorCode, unknown> = {
    'schema.name_reserved': schema([text(1, { apiName: 'String' })]),
    'schema.name_invalid': schema([text(1, { apiName: '1title' })]),
    'schema.name_collision': schema([text(1, { apiName: 'a' }), text(2, { apiName: 'a' })]),
    'schema.reference_unknown': schema([reference(1, [tid(2)])]),
    'schema.too_deep': schema([nested(MAX_FIELD_DEPTH + 1)]),
    'schema.too_large': schema(Array.from({ length: MAX_FIELDS + 1 }, (_, i) => text(i + 1))),
    'schema.breaking_in_place': next(unit, [text(2)]),
    'schema.limit_reached': schema([richText(1, { filterable: true })]),
    'schema.malformed': { typeId: 'x' },
  };

  it('covers the whole list', () => {
    expect(Object.keys(table).sort()).toEqual([...SCHEMA_ERROR_CODES].sort());
  });

  it.each(Object.entries(table))('%s', (code, input) => {
    const prior = code === 'schema.breaking_in_place' ? unit : null;
    expect(codes(input, prior)).toContain(code);
  });
});

describe('a valid first version', () => {
  it('accepts every field kind and lists each field as added', () => {
    const fields = [
      text(1, { filterable: true }),
      richText(2),
      markdown(3),
      number(4, { filterable: true, sortable: true }),
      bool(5, { filterable: true }),
      date(6, { sortable: true }),
      asset(7),
      reference(8, [tid(1)], { filterable: true }),
      list(9, text(10, {}, 32), { filterable: true }),
      object(11, [text(12)]),
    ];
    const result = validateSchema(schema(fields), null);
    expect(result).toEqual({
      ok: true,
      value: {
        fromVersion: null,
        toVersion: 1,
        additive: true,
        added: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(fid),
        changed: [],
        deprecated: [],
        restored: [],
        removed: [],
      },
    });
  });

  it('must be version 1', () => {
    expect(codes(schema([text(1)], { version: 2 }))).toEqual(['schema.malformed']);
  });

  it('reports every problem at once, each with a path', () => {
    const result = validateSchema(
      schema([text(1, { apiName: 'bad name' }), object(2, [text(3, { apiName: 'String' })])]),
      null,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('schema.name_invalid');
    expect(result.error.issues).toEqual([
      { path: 'fields.0.apiName', code: 'schema.name_invalid' },
      { path: 'fields.1.fields.0.apiName', code: 'schema.name_reserved' },
    ]);
  });

  it('caps the issue list, as it goes back to a client', () => {
    const fields = Array.from({ length: MAX_FIELDS }, (_, i) => text(i + 1, { apiName: '1' }));
    const result = validateSchema(schema(fields), null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues).toHaveLength(50);
  });
});

describe('names', () => {
  it('checks the type name too', () => {
    expect(codes(schema([text(1)], { apiName: 'Query' }))).toEqual(['schema.name_reserved']);
    expect(codes(schema([text(1)], { apiName: 'a-b' }))).toEqual(['schema.name_invalid']);
  });

  it('refuses names that differ only by case, as some consumers fold case', () => {
    expect(codes(schema([text(1, { apiName: 'title' }), text(2, { apiName: 'Title' })]))).toEqual([
      'schema.name_collision',
    ]);
  });

  it('allows one name in two scopes', () => {
    const inner = text(2, { apiName: 'title' });
    expect(codes(schema([text(1, { apiName: 'title' }), object(3, [inner])]))).toEqual([]);
  });

  it('refuses one id used twice at any depth', () => {
    expect(
      codes(schema([text(1, { apiName: 'a' }), object(2, [text(1, { apiName: 'b' })])])),
    ).toEqual(['schema.name_collision']);
  });
});

describe('references', () => {
  const check = (to: readonly ReturnType<typeof tid>[], known: ReturnType<typeof tid>[]) =>
    validateSchema(schema([reference(1, to)]), null, { knownTypes: new Set(known) });

  it('allows a reference to itself with no known list', () => {
    expect(validateSchema(schema([reference(1, [tid(1)])]), null).ok).toBe(true);
  });

  it('allows a known type', () => {
    expect(check([tid(2)], [tid(2)]).ok).toBe(true);
  });

  it('refuses an empty target list', () => {
    expect(codes(schema([reference(1, [])]))).toEqual(['schema.reference_unknown']);
  });

  it('refuses a repeated target, which a generated union cannot hold', () => {
    expect(codes(schema([reference(1, [tid(1), tid(1)])]))).toEqual(['schema.malformed']);
  });

  it('refuses a deprecated id that is not a field', () => {
    expect(codes(schema([text(1)], { deprecated: [fid(9)] }))).toEqual([
      'schema.reference_unknown',
    ]);
  });

  it('refuses a repeated deprecated id', () => {
    expect(codes(schema([text(1)], { deprecated: [fid(1), fid(1)] }))).toEqual([
      'schema.malformed',
    ]);
  });
});

describe('the retired list', () => {
  it('must start empty', () => {
    expect(codes(schema([text(1)], { retired: [fid(2)] }))).toEqual(['schema.malformed']);
  });

  it('refuses a repeat', () => {
    const prior = schema([text(1)], { version: 2, retired: [fid(2)] });
    expect(codes(next(prior, prior.fields, [], [fid(2), fid(2)]), prior)).toEqual([
      'schema.malformed',
    ]);
  });

  it('refuses a deprecated id that was retired', () => {
    const prior = schema([text(1)], { version: 2, retired: [fid(2)] });
    expect(codes(next(prior, prior.fields, [fid(2)]), prior)).toEqual(['schema.reference_unknown']);
  });

  it('is capped, and a stored list at the cap still passes', () => {
    const ids = Array.from({ length: MAX_RETIRED_FIELDS + 1 }, (_, i) => fid(i + 10));
    const full = schema([text(1)], { version: 2, retired: ids.slice(1) });
    expect(codes(next(full), full)).toEqual([]);
    expect(codes(next(full, full.fields, [], ids), full)).toContain('schema.too_large');
  });
});

describe('size limits', () => {
  it('accepts the deepest and largest allowed schema', () => {
    expect(codes(schema([nested(MAX_FIELD_DEPTH)]))).toEqual([]);
    expect(codes(schema(Array.from({ length: MAX_FIELDS }, (_, i) => text(i + 1))))).toEqual([]);
  });

  it('counts list nesting as depth', () => {
    let field: FieldDef = text(1);
    for (let i = 2; i <= MAX_FIELD_DEPTH + 1; i += 1) field = list(i, field);
    expect(codes(schema([field]))).toEqual(['schema.too_deep']);
  });

  it('counts nested fields towards the total, and reports it once', () => {
    const inner = Array.from({ length: MAX_FIELDS + 5 }, (_, i) => text(i + 2));
    expect(codes(schema([object(1, inner)]))).toEqual(['schema.too_large']);
  });

  it.each<[string, FieldDef]>([
    ['label', text(1, { label: 'x'.repeat(MAX_LABEL_LENGTH + 1) })],
    ['text length', text(1, {}, MAX_TEXT_BYTES + 1)],
    ['markdown length', markdown(1, {}, MAX_TEXT_BYTES + 1)],
    ['list length', list(1, text(2), {}, 1_001)],
    [
      'reference targets',
      reference(
        1,
        Array.from({ length: MAX_REFERENCE_TARGETS + 1 }, (_, i) => tid(i + 1)),
      ),
    ],
    [
      'asset types',
      { ...asset(1), accept: Array.from({ length: 33 }, (_, i) => `image/x${i}`) } as FieldDef,
    ],
  ])('refuses an oversized %s', (_name, field) => {
    expect(codes(schema([field]))).toContain('schema.too_large');
  });
});

describe('number fields', () => {
  const withBounds = (scale: number, min?: unknown, max?: unknown) =>
    schema([
      {
        ...number(1),
        scale,
        ...(min === undefined ? {} : { min }),
        ...(max === undefined ? {} : { max }),
      } as FieldDef,
    ]);

  it.each([0, 1, 2, 3, 4, 5, 6])('accepts scale %i', (scale) => {
    expect(codes(withBounds(scale))).toEqual([]);
  });

  it.each([-1, 7, 1.5, '2', null])('refuses scale %s', (scale) => {
    expect(codes(withBounds(scale as number))).toEqual(['schema.malformed']);
  });

  it('accepts bounds written to the scale', () => {
    expect(codes(withBounds(2, '-1.50', '99.99'))).toEqual([]);
  });

  it.each<[string, number, unknown, unknown]>([
    ['more digits than the scale', 2, '1.005', undefined],
    ['a fraction at scale 0', 0, '1.5', undefined],
    ['exponent form', 2, '1e3', undefined],
    ['a number, not a string', 2, 1.5, undefined],
    ['min above max', 2, '2.00', '1.00'],
    ['a value past int8', 0, '9223372036854775808', undefined],
  ])('refuses %s', (_name, scale, min, max) => {
    expect(codes(withBounds(scale, min, max))).toEqual(['schema.malformed']);
  });
});

describe('declared filter fields', () => {
  const texts = (n: number) =>
    Array.from({ length: n }, (_, i) => text(i + 1, { filterable: true }));
  const numbers = (n: number) =>
    Array.from({ length: n }, (_, i) => number(i + 101, { filterable: true }));
  const dates = (n: number) =>
    Array.from({ length: n }, (_, i) => date(i + 201, { filterable: true }));

  it('accepts twelve: five text, five integer, two time', () => {
    expect(codes(schema([...texts(5), ...numbers(5), ...dates(2)]))).toEqual([]);
  });

  it.each<[string, readonly FieldDef[], string]>([
    ['a sixth text', [...texts(6)], 'text_slots'],
    ['a sixth integer', [...numbers(6)], 'integer_slots'],
    ['a third time', [...dates(3)], 'time_slots'],
    ['a thirteenth overall', [...texts(5), ...numbers(5), ...dates(3)], 'time_slots'],
  ])('refuses %s', (_name, fields, reason) => {
    const result = validateSchema(schema(fields), null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues).toEqual([
      {
        path: expect.stringMatching(/^fields\.\d+$/) as string,
        code: 'schema.limit_reached',
        reason,
      },
    ]);
  });

  it('counts a sortable field, which also takes a slot', () => {
    const sorted = Array.from({ length: 6 }, (_, i) => number(i + 1, { sortable: true }));
    expect(codes(schema(sorted))).toEqual(['schema.limit_reached']);
  });

  it('counts booleans and single references in their slots', () => {
    const bools = Array.from({ length: 6 }, (_, i) => bool(i + 1, { filterable: true }));
    const refs = Array.from({ length: 6 }, (_, i) =>
      reference(i + 1, [tid(1)], { filterable: true }),
    );
    expect(codes(schema(bools))).toEqual(['schema.limit_reached']);
    expect(codes(schema(refs))).toEqual(['schema.limit_reached']);
  });

  it('counts a deprecated field, which keeps its slot', () => {
    const fields = texts(6);
    expect(codes(schema(fields, { deprecated: [fid(1)] }))).toEqual(['schema.limit_reached']);
  });

  it.each<[string, FieldDef, string]>([
    ['text over 256 bytes', text(1, { filterable: true }, 257), 'not_declarable'],
    ['rich text', richText(1, { filterable: true }), 'not_declarable'],
    ['plain Markdown', markdown(1, { sortable: true }), 'not_declarable'],
    ['an asset', asset(1, { filterable: true }), 'not_declarable'],
    ['an object', object(1, [text(2)], { filterable: true }), 'not_declarable'],
    ['a many reference', reference(1, [tid(1)], { filterable: true }, true), 'not_declarable'],
    ['a list of numbers', list(1, number(2), { filterable: true }), 'not_declarable'],
    ['a list of long text', list(1, text(2, {}, 33), { filterable: true }), 'not_declarable'],
    ['a long list', list(1, text(2, {}, 32), { filterable: true }, 33), 'not_declarable'],
    ['a sorted list', list(1, text(2, {}, 32), { sortable: true }), 'not_declarable'],
    ['a unique rich text', richText(1, { unique: true }), 'not_declarable'],
    ['a nested field', object(1, [text(2, { filterable: true })]), 'nested_declaration'],
    ['a list item', list(1, text(2, { sortable: true })), 'nested_declaration'],
  ])('refuses to declare %s', (_name, field, reason) => {
    const result = validateSchema(schema([field]), null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues[0]).toMatchObject({ code: 'schema.limit_reached', reason });
  });

  it('allows a text value of exactly 256 bytes and a list of 32 by 32', () => {
    expect(codes(schema([text(1, { filterable: true }, 256)]))).toEqual([]);
    expect(codes(schema([list(1, text(2, {}, 32), { filterable: true }, 32)]))).toEqual([]);
  });
});

describe('rich text and Markdown', () => {
  it('keeps them as separate kinds, so swapping one for the other is a retype', () => {
    const prior = schema([richText(1)]);
    expect(codes(next(prior, [markdown(1)]), prior)).toEqual(['schema.breaking_in_place']);
    const plain = schema([markdown(1)]);
    expect(codes(next(plain, [richText(1)]), plain)).toEqual(['schema.breaking_in_place']);
  });

  it('gives rich text no string options, as it stores a tree', () => {
    expect(codes(schema([{ ...richText(1), maxLength: 10 } as FieldDef]))).toEqual([
      'schema.malformed',
    ]);
  });
});

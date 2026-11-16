import { describe, expect, it } from 'vitest';
import { compileValidator } from '../src/index.ts';
import {
  EMPTY_TREE,
  asset,
  bool,
  date,
  fid,
  list,
  markdown,
  number,
  object,
  reference,
  richText,
  schemaOf,
  text,
} from './support.ts';

const REF = '0190a7b0-0000-7000-8000-0000000000aa';

const issuesOf = (validate: ReturnType<typeof compileValidator>, input: unknown) => {
  const result = validate(input);
  return result.ok ? [] : result.error;
};

describe('compileValidator', () => {
  it('refuses anything that is not a plain object', () => {
    const validate = compileValidator(schemaOf([text(1)]));
    for (const input of [null, 'x', 1, [], new Date(0), Object.create({ field1: 'x' })]) {
      expect(issuesOf(validate, input)).toEqual([{ path: '', code: 'field.type' }]);
    }
  });

  it('keys the output by field id in sorted order', () => {
    const validate = compileValidator(schemaOf([text(9), text(2), bool(5)]));
    const result = validate({ field9: 'b', field2: 'a', field5: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value)).toEqual([fid(2), fid(5), fid(9)]);
    expect(result.value).toEqual({ [fid(2)]: 'a', [fid(5)]: true, [fid(9)]: 'b' });
  });

  it('names an unknown key only when it looks like an API name', () => {
    const validate = compileValidator(schemaOf([text(1)]));
    expect(issuesOf(validate, { other: 'x' })).toEqual([{ path: 'other', code: 'field.unknown' }]);
    expect(issuesOf(validate, { "'; drop table x": 'x' })).toEqual([
      { path: '', code: 'field.unknown' },
    ]);
    expect(issuesOf(validate, JSON.parse('{"__proto__": 1}'))).toEqual([
      { path: '', code: 'field.unknown' },
    ]);
  });

  it('requires required fields, treats null as absent, and drops absent optional ones', () => {
    const validate = compileValidator(schemaOf([text(1, { required: true }), text(2)]));
    expect(issuesOf(validate, {})).toEqual([{ path: 'field1', code: 'field.required' }]);
    expect(issuesOf(validate, { field1: null })).toEqual([
      { path: 'field1', code: 'field.required' },
    ]);
    expect(validate({ field1: 'a', field2: null })).toEqual({
      ok: true,
      value: { [fid(1)]: 'a' },
    });
  });

  it('does not require a deprecated field, which clients are moving off', () => {
    const schema = schemaOf([text(1, { required: true })], { deprecated: [fid(1)] });
    expect(compileValidator(schema)({})).toEqual({ ok: true, value: {} });
  });

  it('checks text by UTF-8 bytes, storable characters and format', () => {
    const validate = compileValidator(
      schemaOf([
        text(1, {}, { maxLength: 4 }),
        text(2, {}, { format: 'slug' }),
        text(3, {}, { format: 'email' }),
        text(4, {}, { format: 'url' }),
      ]),
    );
    expect(issuesOf(validate, { field1: 'abcd' })).toEqual([]);
    expect(issuesOf(validate, { field1: 'abcde' })).toEqual([
      { path: 'field1', code: 'field.too_long' },
    ]);
    expect(issuesOf(validate, { field1: 'ééé' })).toEqual([
      { path: 'field1', code: 'field.too_long' },
    ]);
    expect(issuesOf(validate, { field1: 'a\u0000' })).toEqual([
      { path: 'field1', code: 'field.text' },
    ]);
    expect(issuesOf(validate, { field1: '\ud800' })).toEqual([
      { path: 'field1', code: 'field.text' },
    ]);
    expect(issuesOf(validate, { field1: 3 })).toEqual([{ path: 'field1', code: 'field.type' }]);
    expect(
      issuesOf(validate, { field2: 'good-slug-1', field3: 'a@b.co', field4: 'https://x.io/a' }),
    ).toEqual([]);
    expect(
      issuesOf(validate, { field2: 'Bad Slug', field3: 'nope', field4: 'javascript:x' }),
    ).toEqual([
      { path: 'field2', code: 'field.format' },
      { path: 'field3', code: 'field.format' },
      { path: 'field4', code: 'field.format' },
    ]);
  });

  it('checks markdown as text without a format', () => {
    const validate = compileValidator(schemaOf([markdown(1)]));
    expect(validate({ field1: '# Hi' })).toEqual({ ok: true, value: { [fid(1)]: '# Hi' } });
    expect(issuesOf(validate, { field1: 'x'.repeat(1001) })).toEqual([
      { path: 'field1', code: 'field.too_long' },
    ]);
  });

  it('takes numbers only as decimal strings, refuses extra digits and checks bounds', () => {
    const validate = compileValidator(
      schemaOf([number(1, {}, { scale: 2, min: '-1.5', max: '10' })]),
    );
    expect(validate({ field1: '1.5' })).toEqual({ ok: true, value: { [fid(1)]: '1.50' } });
    expect(validate({ field1: '-1.50' })).toEqual({ ok: true, value: { [fid(1)]: '-1.50' } });
    expect(issuesOf(validate, { field1: 1.5 })).toEqual([{ path: 'field1', code: 'field.type' }]);
    expect(issuesOf(validate, { field1: '1.555' })).toEqual([
      { path: 'field1', code: 'field.number' },
    ]);
    expect(issuesOf(validate, { field1: '1e3' })).toEqual([
      { path: 'field1', code: 'field.number' },
    ]);
    expect(issuesOf(validate, { field1: '10.01' })).toEqual([
      { path: 'field1', code: 'field.range' },
    ]);
    expect(issuesOf(validate, { field1: '-1.51' })).toEqual([
      { path: 'field1', code: 'field.range' },
    ]);
  });

  it('takes booleans only as booleans', () => {
    const validate = compileValidator(schemaOf([bool(1)]));
    expect(validate({ field1: false })).toEqual({ ok: true, value: { [fid(1)]: false } });
    expect(issuesOf(validate, { field1: 'true' })).toEqual([
      { path: 'field1', code: 'field.type' },
    ]);
  });

  it('stores an instant in its canonical form and a day as sent', () => {
    const validate = compileValidator(schemaOf([date(1, {}, true), date(2, {}, false)]));
    expect(validate({ field1: '2026-01-01T01:00:00+01:00', field2: '2026-02-03' })).toEqual({
      ok: true,
      value: { [fid(1)]: '2026-01-01T00:00:00.000Z', [fid(2)]: '2026-02-03' },
    });
    expect(issuesOf(validate, { field1: '2026-01-01', field2: '2026-02-30' })).toEqual([
      { path: 'field1', code: 'field.date' },
      { path: 'field2', code: 'field.date' },
    ]);
    expect(issuesOf(validate, { field1: 0 })).toEqual([{ path: 'field1', code: 'field.type' }]);
  });

  it('takes rich text as a checked tree', () => {
    const validate = compileValidator(schemaOf([richText(1)]));
    expect(validate({ field1: EMPTY_TREE })).toEqual({ ok: true, value: { [fid(1)]: EMPTY_TREE } });
    expect(issuesOf(validate, { field1: { ...EMPTY_TREE, astVersion: 99 } })).toEqual([
      { path: 'field1', code: 'field.rich_text' },
    ]);
    expect(issuesOf(validate, { field1: '# not a tree' })).toEqual([
      { path: 'field1', code: 'field.rich_text' },
    ]);
  });

  it('takes assets and references as ids', () => {
    const validate = compileValidator(
      schemaOf([asset(1), reference(2, false), reference(3, true)]),
    );
    expect(validate({ field1: REF, field2: REF, field3: [REF, REF] })).toEqual({
      ok: true,
      value: { [fid(1)]: REF, [fid(2)]: REF, [fid(3)]: [REF, REF] },
    });
    expect(
      issuesOf(validate, { field1: 'x', field2: REF.toUpperCase(), field3: [REF, 'y'] }),
    ).toEqual([
      { path: 'field1', code: 'field.format' },
      { path: 'field2', code: 'field.format' },
      { path: 'field3.1', code: 'field.format' },
    ]);
    expect(issuesOf(validate, { field3: REF })).toEqual([{ path: 'field3', code: 'field.type' }]);
    expect(issuesOf(validate, { field3: Array.from({ length: 1001 }, () => REF) })).toEqual([
      { path: 'field3', code: 'field.too_many' },
    ]);
  });

  it('checks list length and each item by its position', () => {
    const validate = compileValidator(
      schemaOf([list(1, text(2, { apiName: 'item' }, { maxLength: 2 }), 3, { required: true })]),
    );
    expect(validate({ field1: ['a', 'b'] })).toEqual({ ok: true, value: { [fid(1)]: ['a', 'b'] } });
    expect(issuesOf(validate, { field1: ['a', 'b', 'c', 'd'] })).toEqual([
      { path: 'field1', code: 'field.too_many' },
    ]);
    expect(issuesOf(validate, { field1: ['a', 'abc', null] })).toEqual([
      { path: 'field1.1', code: 'field.too_long' },
      { path: 'field1.2', code: 'field.type' },
    ]);
    expect(issuesOf(validate, { field1: [] })).toEqual([
      { path: 'field1', code: 'field.required' },
    ]);
    expect(issuesOf(validate, { field1: 'a' })).toEqual([{ path: 'field1', code: 'field.type' }]);
  });

  it('checks objects by their own fields and names nested paths', () => {
    const validate = compileValidator(
      schemaOf([
        object(1, [text(2, { apiName: 'name', required: true }), bool(3, { apiName: 'on' })]),
      ]),
    );
    expect(validate({ field1: { name: 'x', on: true } })).toEqual({
      ok: true,
      value: { [fid(1)]: { [fid(2)]: 'x', [fid(3)]: true } },
    });
    expect(issuesOf(validate, { field1: { on: 'y', extra: 1 } })).toEqual([
      { path: 'field1.extra', code: 'field.unknown' },
      { path: 'field1.name', code: 'field.required' },
      { path: 'field1.on', code: 'field.type' },
    ]);
    expect(issuesOf(validate, { field1: [] })).toEqual([{ path: 'field1', code: 'field.type' }]);
  });

  it('caps the issues it reports', () => {
    const fields = Array.from({ length: 80 }, (_, i) => bool(i + 1, { required: true }));
    expect(issuesOf(compileValidator(schemaOf(fields)), {})).toHaveLength(50);
  });

  it('never repeats a value the client sent', () => {
    const validate = compileValidator(schemaOf([text(1, {}, { maxLength: 2, format: 'email' })]));
    const secret = 'person@example.com';
    expect(JSON.stringify(validate({ field1: secret }))).not.toContain('person');
  });
});

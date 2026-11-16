import { describe, expect, it } from 'vitest';
import { validateSchema, type ContentSchema, type FieldDef, type FieldId } from '../src/index.ts';
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

const diff = (
  after: ContentSchema,
  before: ContentSchema,
  options?: Parameters<typeof validateSchema>[2],
) => {
  const result = validateSchema(after, before, options);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

const refused = (after: ContentSchema, before: ContentSchema, options = {}) => {
  const result = validateSchema(after, before, options);
  return result.ok ? undefined : result.error.issues[0];
};

const retyped = (a: FieldDef, b: FieldDef, reason: string) => {
  const prior = schema([a]);
  expect(refused(next(prior, [b]), prior)).toMatchObject({
    code: 'schema.breaking_in_place',
    reason,
  });
};

const allowed = (a: FieldDef, b: FieldDef) => {
  const prior = schema([a]);
  expect(diff(next(prior, [b]), prior).changed).toEqual([a.id]);
};

describe('adding', () => {
  it('accepts a new optional field as additive', () => {
    const prior = schema([text(1)]);
    expect(diff(next(prior, [text(1), number(2)]), prior)).toEqual({
      fromVersion: 1,
      toVersion: 2,
      additive: true,
      added: [fid(2)],
      changed: [],
      deprecated: [],
      restored: [],
      removed: [],
    });
  });

  it('adds nested fields the same way', () => {
    const prior = schema([object(1, [text(2)])]);
    const after = next(prior, [object(1, [text(2), text(3)])]);
    expect(diff(after, prior).added).toEqual([fid(3)]);
  });

  it('refuses a new required field: writers that omit it would start failing', () => {
    const prior = schema([text(1)]);
    const after = next(prior, [text(1), text(2, { required: true })]);
    expect(refused(after, prior)).toMatchObject({
      code: 'schema.breaking_in_place',
      reason: 'required_added',
      fieldId: fid(2),
    });
  });

  it('accepts required fields inside a new object, which no writer has sent', () => {
    const prior = schema([text(1)]);
    const after = next(prior, [text(1), object(2, [text(3, { required: true })])]);
    expect(diff(after, prior).added).toEqual([fid(2), fid(3)]);
  });

  it('accepts a required field at creation', () => {
    expect(validateSchema(schema([text(1, { required: true })]), null).ok).toBe(true);
  });
});

describe('removing', () => {
  it('refuses a removal in place', () => {
    const prior = schema([text(1), text(2)]);
    expect(refused(next(prior, [text(1)]), prior)).toEqual({
      path: 'fields.1',
      code: 'schema.breaking_in_place',
      reason: 'removed',
      fieldId: fid(2),
    });
  });

  it('refuses a nested removal', () => {
    const prior = schema([object(1, [text(2), text(3)])]);
    expect(refused(next(prior, [object(1, [text(2)])]), prior)).toMatchObject({
      path: 'fields.0.fields.1',
      reason: 'removed',
    });
  });

  it('keeps a deprecated field served in the next version', () => {
    const prior = schema([text(1), text(2)]);
    const after = next(prior, prior.fields, [fid(2)]);
    expect(diff(after, prior)).toMatchObject({
      deprecated: [fid(2)],
      removed: [],
      additive: false,
    });
    expect(after.fields.map((f) => f.id)).toContain(fid(2));
  });

  it('refuses to drop a deprecated field until a person confirms', () => {
    const prior = schema([text(1), text(2)], { deprecated: [fid(2)] });
    const after = next(prior, [text(1)], []);
    expect(refused(after, prior)).toMatchObject({
      code: 'schema.breaking_in_place',
      reason: 'removal_unconfirmed',
    });
    expect(refused(after, prior, { confirmedRemovals: [fid(1)] })).toMatchObject({
      reason: 'removal_unconfirmed',
    });
  });

  it('removes a deprecated field once confirmed', () => {
    const prior = schema([text(1), text(2)], { deprecated: [fid(2)] });
    const after = next(prior, [text(1)], [], [fid(2)]);
    expect(diff(after, prior, { confirmedRemovals: [fid(2)] })).toMatchObject({
      removed: [fid(2)],
      additive: false,
    });
  });

  it('will not take a confirmation in place of deprecating first', () => {
    const prior = schema([text(1), text(2)]);
    const after = next(prior, [text(1)]);
    expect(refused(after, prior, { confirmedRemovals: [fid(2)] })).toMatchObject({
      reason: 'removed',
    });
  });

  it('removes children with a confirmed parent', () => {
    const prior = schema([text(1), object(2, [text(3)])], { deprecated: [fid(2)] });
    const after = next(prior, [text(1)], [], [fid(2), fid(3)]);
    expect(diff(after, prior, { confirmedRemovals: [fid(2)] }).removed).toEqual([fid(2), fid(3)]);
  });

  it('can bring a deprecated field back', () => {
    const prior = schema([text(1)], { deprecated: [fid(1)] });
    expect(diff(next(prior, prior.fields, []), prior)).toMatchObject({
      restored: [fid(1)],
      deprecated: [],
    });
  });

  it('expresses a retype as a new field beside a deprecated one', () => {
    const prior = schema([text(1, { apiName: 'price' })]);
    const after = next(
      prior,
      [text(1, { apiName: 'price' }), number(2, { apiName: 'priceAmount' })],
      [fid(1)],
    );
    expect(diff(after, prior)).toMatchObject({ added: [fid(2)], deprecated: [fid(1)] });
  });
});

describe('changes in place', () => {
  it.each<[string, FieldDef, FieldDef, string]>([
    ['kind', text(1), number(1), 'retyped'],
    ['rich text to text', richText(1), text(1), 'retyped'],
    ['number scale', number(1), { ...number(1), scale: 3 } as FieldDef, 'retyped'],
    ['date precision', date(1), { ...date(1), withTime: false } as FieldDef, 'retyped'],
    ['reference count', reference(1), reference(1, [tid(1)], {}, true), 'retyped'],
    ['localized', text(1), text(1, { localized: true }), 'retyped'],
    ['api name', text(1), text(1, { apiName: 'other' }), 'renamed'],
    ['text length down', text(1, {}, 10), text(1, {}, 9), 'narrowed'],
    ['Markdown length down', markdown(1, {}, 10), markdown(1, {}, 9), 'narrowed'],
    ['text format set', text(1), { ...text(1), format: 'email' } as FieldDef, 'narrowed'],
    ['list length down', list(1, text(2), {}, 5), list(1, text(2), {}, 4), 'narrowed'],
    [
      'asset type dropped',
      asset(1),
      { ...asset(1), accept: ['image/png'] } as FieldDef,
      'narrowed',
    ],
    [
      'reference target dropped',
      reference(1, [tid(1), tid(2)]),
      reference(1, [tid(1)]),
      'narrowed',
    ],
    ['unique added', text(1), text(1, { unique: true }), 'narrowed'],
    ['min added', number(1), { ...number(1), min: '0.00' } as FieldDef, 'narrowed'],
    ['max added', number(1), { ...number(1), max: '9.00' } as FieldDef, 'narrowed'],
    [
      'min raised',
      { ...number(1), min: '1.00' } as FieldDef,
      { ...number(1), min: '1.50' } as FieldDef,
      'narrowed',
    ],
    [
      'max lowered',
      { ...number(1), max: '2.00' } as FieldDef,
      { ...number(1), max: '1.50' } as FieldDef,
      'narrowed',
    ],
    ['required added', text(1), text(1, { required: true }), 'required_added'],
    ['required dropped', text(1, { required: true }), text(1), 'required_dropped'],
    ['filter dropped', text(1, { filterable: true }), text(1), 'undeclared'],
    ['sort dropped', number(1, { sortable: true }), number(1), 'undeclared'],
    ['list item swapped', list(1, text(2)), list(1, text(3)), 'retyped'],
  ])('refuses %s', (_name, a, b, reason) => {
    retyped(a, b, reason);
  });

  it.each<[string, FieldDef, FieldDef]>([
    ['label', text(1), text(1, { label: 'New label' })],
    ['text length up', text(1, {}, 10), text(1, {}, 11)],
    ['Markdown length up', markdown(1, {}, 10), markdown(1, {}, 11)],
    ['list length up', list(1, text(2), {}, 5), list(1, text(2), {}, 6)],
    ['text format dropped', { ...text(1), format: 'email' } as FieldDef, text(1)],
    ['format set to plain', text(1), { ...text(1), format: 'plain' } as FieldDef],
    [
      'asset type added',
      asset(1),
      { ...asset(1), accept: ['image/png', 'image/*', 'a/b'] } as FieldDef,
    ],
    ['unique dropped', text(1, { unique: true }), text(1)],
    ['filter declared', text(1), text(1, { filterable: true })],
    ['sort declared', number(1), number(1, { sortable: true })],
    ['min dropped', { ...number(1), min: '1.00' } as FieldDef, number(1)],
    ['max dropped', { ...number(1), max: '1.00' } as FieldDef, number(1)],
    [
      'min lowered',
      { ...number(1), min: '1.00' } as FieldDef,
      { ...number(1), min: '0.50' } as FieldDef,
    ],
    [
      'max raised',
      { ...number(1), max: '1.00' } as FieldDef,
      { ...number(1), max: '1.50' } as FieldDef,
    ],
  ])('allows %s', (_name, a, b) => {
    allowed(a, b);
  });

  it('accepts a reference target known to the caller', () => {
    const prior = schema([reference(1)]);
    const after = next(prior, [reference(1, [tid(1), tid(2)])]);
    expect(refused(after, prior)).toMatchObject({ code: 'schema.reference_unknown' });
    expect(diff(after, prior, { knownTypes: new Set([tid(2)]) }).changed).toEqual([fid(1)]);
  });

  it('refuses a retype of a deprecated field, which is still served', () => {
    const prior = schema([text(1)], { deprecated: [fid(1)] });
    expect(refused(next(prior, [bool(1)]), prior)).toMatchObject({ reason: 'retyped' });
  });

  it('lets a deprecated field stop being required', () => {
    const prior = schema([text(1, { required: true })]);
    const after = next(prior, [text(1)], [fid(1)]);
    expect(diff(after, prior).deprecated).toEqual([fid(1)]);
  });

  it('refuses moving a field to another parent', () => {
    const prior = schema([text(1), object(2, [text(3)])]);
    const after = next(prior, [object(2, [text(3), text(1)])]);
    expect(refused(after, prior)).toMatchObject({ reason: 'moved', fieldId: fid(1) });
  });

  it('finds a retype inside a list item', () => {
    const prior = schema([list(1, object(2, [text(3)]))]);
    const after = next(prior, [list(1, object(2, [bool(3)]))]);
    expect(refused(after, prior)).toMatchObject({
      path: 'fields.0.of.fields.0',
      reason: 'retyped',
      fieldId: fid(3),
    });
  });

  it('ignores field order', () => {
    const prior = schema([text(1), text(2)]);
    expect(diff(next(prior, [text(2), text(1)]), prior)).toMatchObject({
      added: [],
      changed: [],
      additive: true,
    });
  });

  it('fails closed on a stored bound it cannot read', () => {
    const prior = schema([{ ...number(1), min: 'junk' } as FieldDef]);
    const after = next(prior, [{ ...number(1), min: '1.00' } as FieldDef]);
    expect(refused(after, prior)).toMatchObject({ reason: 'narrowed' });
  });
});

describe('list elements', () => {
  const confirmed = { confirmedRemovals: [fid(2)] };

  it('refuses swapping an element after a confirmed removal', () => {
    const prior = schema([list(1, text(2))], { deprecated: [fid(2)] });
    const after = next(prior, [list(1, number(3))], [], [fid(2)]);
    expect(refused(after, prior, confirmed)).toEqual({
      path: 'fields.0.of',
      code: 'schema.breaking_in_place',
      reason: 'retyped',
      fieldId: fid(2),
    });
  });

  it('refuses it inside a nested list and inside an object', () => {
    const nestedList = schema([list(1, list(4, text(2)))], { deprecated: [fid(2)] });
    const afterList = next(nestedList, [list(1, list(4, number(3)))], [], [fid(2)]);
    expect(refused(afterList, nestedList, confirmed)).toMatchObject({ reason: 'retyped' });

    const inObject = schema([object(4, [list(1, text(2))])], { deprecated: [fid(2)] });
    const afterObject = next(inObject, [object(4, [list(1, number(3))])], [], [fid(2)]);
    expect(refused(afterObject, inObject, confirmed)).toMatchObject({ reason: 'retyped' });
  });

  it('still removes a list with its element', () => {
    const prior = schema([text(4), list(1, text(2))], { deprecated: [fid(1)] });
    const after = next(prior, [text(4)], [], [fid(1), fid(2)]);
    expect(diff(after, prior, { confirmedRemovals: [fid(1)] }).removed).toEqual([fid(1), fid(2)]);
  });

  it('still removes a confirmed field of an object element', () => {
    const prior = schema([list(1, object(2, [text(3), text(4)]))], { deprecated: [fid(4)] });
    const after = next(prior, [list(1, object(2, [text(3)]))], [], [fid(4)]);
    expect(diff(after, prior, { confirmedRemovals: [fid(4)] }).removed).toEqual([fid(4)]);
  });
});

describe('removed ids', () => {
  const start = schema([text(1), text(2)], { deprecated: [fid(2)] });
  const gone = next(start, [text(1)], [], [fid(2)]);

  it('records a removal for good', () => {
    const later = next(gone, [text(1), text(3)]);
    expect(diff(later, gone).added).toEqual([fid(3)]);
    expect(later.retired).toEqual([fid(2)]);
  });

  it.each<[string, FieldDef]>([
    ['a new kind', number(2)],
    ['the same kind', text(2)],
    ['another name', text(2, { apiName: 'other' })],
  ])('refuses the id coming back with %s', (_name, field) => {
    expect(refused(next(gone, [text(1), field]), gone)).toMatchObject({
      code: 'schema.breaking_in_place',
      reason: 'reused',
      fieldId: fid(2),
    });
  });

  it('refuses it inside an object or as a list element', () => {
    const inObject = next(gone, [text(1), object(3, [number(2)])]);
    expect(refused(inObject, gone)).toMatchObject({ reason: 'reused', fieldId: fid(2) });
    const asElement = next(gone, [text(1), list(3, number(2))]);
    expect(refused(asElement, gone)).toMatchObject({ reason: 'reused', fieldId: fid(2) });
  });

  it('refuses it when the record is dropped to hide the reuse', () => {
    const after = next(gone, [text(1), number(2)], [], []);
    expect(refused(after, gone)).toMatchObject({ reason: 'reused', fieldId: fid(2) });
  });

  it.each<[string, readonly FieldId[]]>([
    ['dropped', []],
    ['invented', [fid(2), fid(9)]],
  ])('refuses a record with an id %s', (_name, retired) => {
    expect(refused(next(gone, gone.fields, [], retired), gone)).toEqual({
      path: 'retired',
      code: 'schema.breaking_in_place',
      reason: 'retired',
    });
  });

  it('refuses a confirmed removal left out of the record', () => {
    const after = next(start, [text(1)], [], []);
    expect(refused(after, start, { confirmedRemovals: [fid(2)] })).toMatchObject({
      reason: 'retired',
    });
  });

  it('takes the record in any order', () => {
    const two = schema([text(1)], { version: 3, retired: [fid(2), fid(3)] });
    expect(diff(next(two, two.fields, [], [fid(3), fid(2)]), two).added).toEqual([]);
  });
});

describe('identity and version', () => {
  const prior = schema([text(1)]);

  it.each<[string, ContentSchema, string]>([
    ['a different type id', { ...next(prior), typeId: tid(2) }, 'identity'],
    ['a renamed type', { ...next(prior), apiName: 'Post' }, 'renamed'],
    ['the same version', { ...next(prior), version: 1 }, 'version'],
    ['a skipped version', { ...next(prior), version: 3 }, 'version'],
    ['an older version', { ...next(prior), version: 1 }, 'version'],
  ])('refuses %s', (_name, after, reason) => {
    expect(refused(after, prior)).toMatchObject({ code: 'schema.breaking_in_place', reason });
  });

  it('accepts a version with no change', () => {
    expect(diff(next(prior), prior)).toMatchObject({ added: [], additive: true, toVersion: 2 });
  });
});

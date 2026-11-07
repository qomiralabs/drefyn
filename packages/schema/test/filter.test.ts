import { describe, expect, it } from 'vitest';
import {
  checkFilter,
  FILTER_ERROR_CODES,
  MAX_FILTER_DEPTH,
  MAX_FILTER_IN_VALUES,
  MAX_FILTER_NODES,
  MAX_FILTER_TEXT_BYTES,
  parseFilterNode,
  UNDECLARED_FILTER_MAX_ITEMS,
  type FieldDef,
  type FilterErrorCode,
  type FilterOptions,
  type FilterNode,
} from '../src/index.ts';
import {
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
  schema,
  text,
  tid,
} from './support.ts';

const title = fid(1);
const price = fid(2);
const live = fid(3);
const when = fid(4);
const author = fid(5);
const tags = fid(6);
const notes = fid(7);
const body = fid(8);
const extra = fid(9);
const image = fid(10);
const group = fid(11);
const day = fid(12);

const article = schema([
  text(1, { filterable: true }),
  number(2, { filterable: true }),
  bool(3, { filterable: true }),
  date(4, { filterable: true }),
  reference(5, [tid(1)], { filterable: true }),
  list(6, text(13, {}, 32), { filterable: true }),
  markdown(7),
  richText(8),
  text(9),
  asset(10),
  object(11, [text(14)]),
  { ...date(12), withTime: false } as FieldDef,
]);

const SMALL: FilterOptions = { itemCount: 10 };
const check = (filter: unknown, options = SMALL) => {
  const result = checkFilter(article, filter, options);
  return result.ok ? null : result.error.code;
};

function nestedNot(depth: number): unknown {
  let node: unknown = { field: title, op: 'exists' };
  for (let i = 0; i < depth; i += 1) node = { not: node };
  return node;
}

describe('parseFilterNode', () => {
  it('accepts every node form', () => {
    const filter: FilterNode = {
      and: [
        { or: [{ field: title, op: 'eq', value: 'a' }, { not: { field: live, op: 'exists' } }] },
        { field: title, op: 'in', value: ['a', 'b'] },
        { field: live, op: 'eq', value: true },
      ],
    };
    expect(parseFilterNode(JSON.parse(JSON.stringify(filter)))).toEqual({
      ok: true,
      value: filter,
    });
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['a string', 'title = 1'],
    ['an empty and', { and: [] }],
    ['an empty or', { or: [] }],
    [
      'two forms at once',
      { and: [{ field: title, op: 'exists' }], not: { field: title, op: 'exists' } },
    ],
    ['an unknown operator', { field: title, op: 'regex', value: 'a' }],
    ['a raw SQL operator', { field: title, op: '= 1 or 1=1 --', value: 'a' }],
    ['a free text field', { field: 'title; drop', op: 'eq', value: 'a' }],
    ['a float value', { field: price, op: 'gt', value: 1.5 }],
    ['an integer value', { field: price, op: 'gt', value: 1 }],
    ['a null value', { field: title, op: 'eq', value: null }],
    ['a float in a list', { field: price, op: 'in', value: ['1', 2.5] }],
    ['an object value', { field: title, op: 'eq', value: { $ne: 1 } }],
    ['an extra key', { field: title, op: 'exists', sql: 'x' }],
  ])('refuses %s', (_name, input) => {
    const result = parseFilterNode(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('filter.malformed');
  });

  it('allows the deepest filter and refuses one more', () => {
    expect(parseFilterNode(nestedNot(MAX_FILTER_DEPTH - 1)).ok).toBe(true);
    const result = parseFilterNode(nestedNot(MAX_FILTER_DEPTH));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('filter.too_large');
  });

  it('counts and and or as one level', () => {
    let node: unknown = { field: title, op: 'exists' };
    for (let i = 0; i < MAX_FILTER_DEPTH - 1; i += 1) node = { and: [node] };
    expect(parseFilterNode(node).ok).toBe(true);
    expect(parseFilterNode({ or: [node] }).ok).toBe(false);
  });

  it('refuses hostile shapes without running out of stack', () => {
    for (const input of [
      nestedNot(500_000),
      { and: new Array(5_000_000).fill({ field: title, op: 'exists' }) },
      { field: title, op: 'eq', value: 'x'.repeat(5_000_000) },
    ]) {
      const result = parseFilterNode(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('filter.too_large');
    }
  });

  it('caps the node count below the raw budget', () => {
    const leaf = { field: title, op: 'exists' };
    expect(parseFilterNode({ and: new Array(MAX_FILTER_NODES - 1).fill(leaf) }).ok).toBe(true);
    const result = parseFilterNode({ and: new Array(MAX_FILTER_NODES).fill(leaf) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('filter.too_large');
  });

  it('never repeats input text in an error', () => {
    const secret = 'person@example.com';
    expect(
      JSON.stringify(parseFilterNode({ field: secret, op: secret, value: secret })),
    ).not.toContain(secret);
    expect(
      JSON.stringify(checkFilter(article, { field: price, op: 'eq', value: secret }, SMALL)),
    ).not.toContain(secret);
  });
});

describe('checkFilter errors', () => {
  const table: Record<FilterErrorCode, unknown> = {
    'filter.malformed': { field: 'nope', op: 'eq' },
    'filter.too_large': nestedNot(MAX_FILTER_DEPTH),
    'filter.field_unknown': { field: fid(99), op: 'exists' },
    'filter.op_invalid': { field: body, op: 'exists' },
    'filter.value_invalid': { field: price, op: 'eq', value: 'abc' },
    'filter.not_declared': { field: extra, op: 'eq', value: 'a' },
  };

  it('covers the whole list', () => {
    expect(Object.keys(table).sort()).toEqual([...FILTER_ERROR_CODES].sort());
  });

  it.each(Object.entries(table))('%s', (code, filter) => {
    expect(check(filter, { itemCount: UNDECLARED_FILTER_MAX_ITEMS + 1 })).toBe(code);
  });
});

describe('undeclared fields', () => {
  const undeclared = { field: extra, op: 'eq', value: 'a' };

  it('scans up to 20,000 items and refuses above that', () => {
    expect(UNDECLARED_FILTER_MAX_ITEMS).toBe(20_000);
    expect(check(undeclared, { itemCount: 20_000 })).toBeNull();
    expect(check(undeclared, { itemCount: 20_001 })).toBe('filter.not_declared');
  });

  it('takes the operator limit from config', () => {
    expect(check(undeclared, { itemCount: 11, undeclaredScanMaxItems: 10 })).toBe(
      'filter.not_declared',
    );
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    'refuses a scan when the item count is %s',
    (itemCount) => {
      expect(check(undeclared, { itemCount })).toBe('filter.not_declared');
    },
  );

  it('refuses a scan when the configured limit is not a number', () => {
    expect(check(undeclared, { itemCount: 1, undeclaredScanMaxItems: Number.NaN })).toBe(
      'filter.not_declared',
    );
  });

  it('applies however deep the field sits in the tree', () => {
    const buried = { and: [{ or: [{ not: undeclared }] }] };
    expect(check(buried, { itemCount: 20_001 })).toBe('filter.not_declared');
  });

  it('runs declared fields at any size', () => {
    const declared = { field: title, op: 'eq', value: 'a' };
    expect(check(declared, { itemCount: 10_000_000 })).toBeNull();
  });

  it('treats a sort only field as undeclared for filtering', () => {
    const sorted = schema([number(1, { sortable: true })]);
    const result = checkFilter(
      sorted,
      { field: fid(1), op: 'gt', value: '1.00' },
      { itemCount: 20_001 },
    );
    expect(result.ok).toBe(false);
  });

  it('returns the undeclared fields in one order, each once', () => {
    const filter = {
      and: [
        { field: notes, op: 'exists' },
        { field: extra, op: 'exists' },
        { field: extra, op: 'eq', value: 'a' },
        { field: title, op: 'exists' },
      ],
    };
    const result = checkFilter(article, filter, SMALL);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.undeclared).toEqual([notes, extra].sort());
      expect(result.value.filter).toEqual(filter);
    }
  });

  it('keeps filtering a deprecated field, which is still served', () => {
    const old = { ...article, deprecated: [title] };
    expect(checkFilter(old, { field: title, op: 'exists' }, SMALL).ok).toBe(true);
  });
});

describe('fields filters cannot reach', () => {
  it.each([
    ['a nested field', fid(14)],
    ['a list item', fid(13)],
  ])('treats %s as unknown', (_name, field) => {
    expect(check({ field, op: 'exists' })).toBe('filter.field_unknown');
  });

  it.each([
    ['rich text', body],
    ['an asset', image],
    ['an object', group],
  ])('refuses %s', (_name, field) => {
    expect(check({ field, op: 'exists' })).toBe('filter.op_invalid');
  });

  it('refuses a list of objects', () => {
    const type = schema([list(1, object(2, [text(3)]))]);
    expect(checkFilter(type, { field: fid(1), op: 'exists' }, SMALL)).toMatchObject({
      ok: false,
      error: { code: 'filter.op_invalid' },
    });
  });
});

describe('operators and values', () => {
  it.each<[string, unknown]>([
    ['text eq', { field: title, op: 'eq', value: 'a' }],
    ['text empty eq', { field: title, op: 'eq', value: '' }],
    ['text range', { field: title, op: 'gte', value: 'a' }],
    ['text contains', { field: title, op: 'contains', value: 'a' }],
    ['Markdown contains', { field: notes, op: 'contains', value: 'a' }],
    ['number eq', { field: price, op: 'eq', value: '1.50' }],
    ['number range', { field: price, op: 'lt', value: '-3' }],
    ['number in', { field: price, op: 'in', value: ['1', '2.5'] }],
    ['boolean', { field: live, op: 'neq', value: false }],
    ['date range', { field: when, op: 'gt', value: '2026-11-06T10:00:00Z' }],
    ['date with offset', { field: when, op: 'gt', value: '2026-11-06T10:00:00+01:00' }],
    ['plain date', { field: day, op: 'eq', value: '2024-02-29' }],
    [
      'the first instant Postgres can read here',
      { field: when, op: 'eq', value: '0001-01-01T00:00:00Z' },
    ],
    ['the last instant', { field: when, op: 'eq', value: '9999-12-31T23:59:59Z' }],
    [
      'an offset that stays inside the years',
      { field: when, op: 'eq', value: '0001-01-01T00:00:00-02:00' },
    ],
    ['reference', { field: author, op: 'eq', value: fid(1) }],
    ['list item', { field: tags, op: 'eq', value: 'a' }],
  ])('accepts %s', (_name, filter) => {
    expect(check(filter)).toBeNull();
  });

  it.each<[string, unknown]>([
    ['contains on a number', { field: price, op: 'contains', value: '1' }],
    ['a range on a boolean', { field: live, op: 'gt', value: true }],
    ['in on a boolean', { field: live, op: 'in', value: ['true'] }],
    ['a range on a reference', { field: author, op: 'gt', value: fid(1) }],
    ['eq on Markdown', { field: notes, op: 'eq', value: 'a' }],
    ['contains on a list', { field: tags, op: 'contains', value: 'a' }],
  ])('refuses %s', (_name, filter) => {
    expect(check(filter)).toBe('filter.op_invalid');
  });

  it.each<[string, unknown]>([
    ['exists with a value', { field: title, op: 'exists', value: 'a' }],
    ['no value', { field: title, op: 'eq' }],
    ['a list for eq', { field: title, op: 'eq', value: ['a'] }],
    ['a scalar for in', { field: title, op: 'in', value: 'a' }],
    ['an empty in', { field: title, op: 'in', value: [] }],
    [
      'too many in values',
      { field: title, op: 'in', value: new Array(MAX_FILTER_IN_VALUES + 1).fill('a') },
    ],
    ['one bad in value', { field: price, op: 'in', value: ['1', 'x'] }],
    ['a boolean for text', { field: title, op: 'eq', value: true }],
    ['a string for boolean', { field: live, op: 'eq', value: 'true' }],
    ['an empty contains', { field: title, op: 'contains', value: '' }],
    ['a NUL byte, which Postgres text refuses', { field: title, op: 'eq', value: 'a\u0000' }],
    ['a lone high surrogate', { field: title, op: 'eq', value: '\ud800' }],
    ['a lone low surrogate', { field: title, op: 'contains', value: 'a\udc00b' }],
    ['a lone surrogate in a list', { field: tags, op: 'eq', value: '\ud800' }],
    ['a lone surrogate among in values', { field: title, op: 'in', value: ['a', '\ud800'] }],
    [
      'text past the slot',
      { field: title, op: 'eq', value: 'x'.repeat(MAX_FILTER_TEXT_BYTES + 1) },
    ],
    ['bytes past the slot', { field: title, op: 'eq', value: 'é'.repeat(129) }],
    ['more digits than the scale', { field: price, op: 'eq', value: '1.005' }],
    ['exponent form', { field: price, op: 'eq', value: '1e3' }],
    ['past int8', { field: price, op: 'eq', value: '92233720368547758.08' }],
    ['not a date', { field: when, op: 'eq', value: 'yesterday' }],
    ['a date with no zone', { field: when, op: 'eq', value: '2026-11-06T10:00:00' }],
    ['a plain date on a time field', { field: when, op: 'eq', value: '2026-11-06' }],
    ['a time on a plain date', { field: day, op: 'eq', value: '2026-11-06T10:00:00Z' }],
    ['a date that does not exist', { field: day, op: 'eq', value: '2025-02-29' }],
    ['a plain date in year 0000', { field: day, op: 'eq', value: '0000-06-01' }],
    ['a time in year 0000', { field: when, op: 'eq', value: '0000-06-01T00:00:00Z' }],
    ['a shift into year 0000', { field: when, op: 'eq', value: '0001-01-01T00:00:00+02:00' }],
    ['a shift past year 9999', { field: when, op: 'eq', value: '9999-12-31T23:59:59-01:00' }],
    ['one in value in year 0000', { field: day, op: 'in', value: ['2026-01-01', '0000-06-01'] }],
    ['a reference that is not an id', { field: author, op: 'eq', value: 'x' }],
    ['a list item of the wrong type', { field: tags, op: 'eq', value: true }],
  ])('refuses %s', (_name, filter) => {
    expect(check(filter)).toBe('filter.value_invalid');
  });

  it('points at the failing node', () => {
    const result = checkFilter(
      article,
      { and: [{ field: title, op: 'exists' }, { not: { field: price, op: 'eq', value: 'x' } }] },
      SMALL,
    );
    expect(result).toEqual({
      ok: false,
      error: { code: 'filter.value_invalid', path: 'and.1.not' },
    });
  });
});

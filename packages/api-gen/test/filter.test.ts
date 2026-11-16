import { MAX_FILTER_DEPTH, MAX_FILTER_NODES } from '@drefyn/schema';
import { describe, expect, it } from 'vitest';
import { MAX_FILTER_PARAM_LENGTH, parseFilterParam } from '../src/index.ts';
import { bool, fid, number, object, richText, schemaOf, text } from './support.ts';

const SCHEMA = schemaOf([
  text(1, { apiName: 'title', filterable: true }),
  number(2, { apiName: 'price', filterable: true }),
  bool(3, { apiName: 'live' }),
  richText(4, { apiName: 'body' }),
  object(5, [text(6, { apiName: 'inner' })], { apiName: 'meta' }),
]);

const parse = (value: unknown) =>
  parseFilterParam(SCHEMA, typeof value === 'string' ? value : JSON.stringify(value));

const refused = (path: string, code: string) => ({
  ok: false,
  error: { code: 'api.filter_invalid', fields: [{ path, code }] },
});

function nested(depth: number, wrap: 'not' | 'and'): unknown {
  let node: unknown = { field: 'title', op: 'eq', value: 'x' };
  for (let level = 1; level < depth; level += 1) {
    node = wrap === 'not' ? { not: node } : { and: [node] };
  }
  return node;
}

describe('parseFilterParam', () => {
  it('maps API names to field ids through the whole tree', () => {
    expect(
      parse({
        and: [
          { field: 'title', op: 'contains', value: 'hello' },
          {
            or: [
              { field: 'price', op: 'gte', value: '1.50' },
              { not: { field: 'live', op: 'exists' } },
            ],
          },
        ],
      }),
    ).toEqual({
      ok: true,
      value: {
        and: [
          { field: fid(1), op: 'contains', value: 'hello' },
          {
            or: [
              { field: fid(2), op: 'gte', value: '1.50' },
              { not: { field: fid(3), op: 'exists' } },
            ],
          },
        ],
      },
    });
  });

  it('accepts the deepest legal tree', () => {
    expect(parse(nested(MAX_FILTER_DEPTH, 'not')).ok).toBe(true);
    expect(parse(nested(MAX_FILTER_DEPTH, 'and')).ok).toBe(true);
  });

  it('refuses hostile depth with api.filter_invalid', () => {
    expect(parse(nested(MAX_FILTER_DEPTH + 1, 'not'))).toEqual(refused('', 'filter.too_large'));
    expect(parse(nested(MAX_FILTER_DEPTH + 1, 'and'))).toEqual(refused('', 'filter.too_large'));
    // Nesting this deep would blow a recursive walk; the length cap stops it first.
    const deep = `${'{"not":'.repeat(100_000)}{}${'}'.repeat(100_000)}`;
    expect(parse(deep)).toEqual(refused('', 'filter.too_large'));
    // Short enough to pass the length cap, far too deep for the tree.
    const under = `${'{"not":'.repeat(1500)}{"field":"title","op":"exists"}${'}'.repeat(1500)}`;
    expect(under.length).toBeLessThanOrEqual(MAX_FILTER_PARAM_LENGTH);
    expect(parse(under)).toEqual(refused('', 'filter.too_large'));
    const arrays = `${'['.repeat(5000)}${']'.repeat(5000)}`;
    expect(parse({ and: [JSON.parse(arrays) as unknown] })).toEqual(
      refused('and.0', 'filter.malformed'),
    );
  });

  it('refuses too many nodes', () => {
    const leaf = { field: 'title', op: 'exists' };
    expect(parse({ or: Array.from({ length: MAX_FILTER_NODES }, () => leaf) })).toEqual(
      refused('', 'filter.too_large'),
    );
    expect(parse({ or: Array.from({ length: MAX_FILTER_NODES - 1 }, () => leaf) }).ok).toBe(true);
  });

  it('refuses text that is not JSON, too long, or not a string', () => {
    expect(parse('{"and":')).toEqual(refused('', 'filter.malformed'));
    expect(parseFilterParam(SCHEMA, 42)).toEqual(refused('', 'filter.malformed'));
    expect(parse('x'.repeat(MAX_FILTER_PARAM_LENGTH + 1))).toEqual(refused('', 'filter.too_large'));
  });

  it('refuses unknown names, nested fields and ids sent as names', () => {
    expect(parse({ field: 'nope', op: 'exists' })).toEqual(refused('', 'filter.field_unknown'));
    expect(parse({ not: { field: 'inner', op: 'exists' } })).toEqual(
      refused('not', 'filter.field_unknown'),
    );
    expect(parse({ field: fid(1), op: 'exists' })).toEqual(refused('', 'filter.field_unknown'));
    expect(parse({ field: '__proto__', op: 'exists' })).toEqual(
      refused('', 'filter.field_unknown'),
    );
    expect(parse({ field: 'toString', op: 'exists' })).toEqual(refused('', 'filter.field_unknown'));
  });

  it('refuses extra keys, wrong shapes and bad operators or values', () => {
    expect(parse({ field: 'title', op: 'eq', value: 'x', sql: '1' })).toEqual(
      refused('', 'filter.malformed'),
    );
    expect(parse({ and: [] })).toEqual(refused('', 'filter.malformed'));
    expect(parse({ and: {} })).toEqual(refused('', 'filter.malformed'));
    expect(parse({ and: [{ field: 'title', op: 'eq', value: 'x' }], or: [] })).toEqual(
      refused('', 'filter.malformed'),
    );
    expect(parse([])).toEqual(refused('', 'filter.malformed'));
    expect(parse({ field: 7, op: 'eq' })).toEqual(refused('', 'filter.malformed'));
    expect(parse({ field: 'title', op: 'like', value: 'x' })).toEqual(
      refused('', 'filter.malformed'),
    );
    expect(parse({ field: 'body', op: 'eq', value: 'x' })).toEqual(
      refused('', 'filter.op_invalid'),
    );
    expect(parse({ and: [{ field: 'price', op: 'eq', value: 1.5 }] })).toEqual(
      refused('', 'filter.malformed'),
    );
    expect(parse({ and: [{ field: 'price', op: 'eq', value: '1.555' }] })).toEqual(
      refused('and.0', 'filter.value_invalid'),
    );
  });

  it('lets an undeclared field through for the engine to price', () => {
    expect(parse({ field: 'live', op: 'eq', value: true })).toEqual({
      ok: true,
      value: { field: fid(3), op: 'eq', value: true },
    });
  });
});

import { checkFilter, type FilterNode } from '@drefyn/schema';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseFilterParam } from '../src/index.ts';
import { bool, date, fid, list, number, schemaOf, text } from './support.ts';

const SCHEMA = schemaOf([
  text(1, { apiName: 'title', filterable: true }),
  number(2, { apiName: 'price', filterable: true }),
  bool(3, { apiName: 'live', filterable: true }),
  date(4, { apiName: 'when', filterable: true }),
  list(5, text(15, { apiName: 'item' }, { maxLength: 32 }), 8, {
    apiName: 'tags',
    filterable: true,
  }),
  text(6, { apiName: 'note' }),
]);

const IDS = new Set<string>(SCHEMA.fields.map((field) => field.id));
const NAMES = ['title', 'price', 'live', 'when', 'tags', 'note'];
const OPS = ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists'];
const KEYS = new Set(['and', 'or', 'not', 'field', 'op', 'value']);

// Text a hostile caller would send, marked so a leak can be found by search.
const MARK = 'zqzqmark';
const hostile = fc
  .oneof(
    fc.constantFrom(
      `'; drop table app.nodes; --`,
      `" or 1=1 --`,
      `$1`,
      `t1`,
      `n.head_fields`,
      `\\`,
      `%_`,
      `$$`,
      `/* x */`,
      `__proto__`,
      `constructor`,
    ),
    fc.string({ maxLength: 12 }),
  )
  .map((text) => `${MARK}${text}`);

const value = fc.oneof(
  hostile,
  fc.boolean(),
  fc.array(hostile, { minLength: 1, maxLength: 3 }),
  fc.constantFrom('1.25', '-3', '2026-01-01T00:00:00Z', '0190a7b0-0000-7000-8000-0000000000aa'),
);

const name = fc.oneof({ weight: 4, arbitrary: fc.constantFrom(...NAMES) }, hostile);
const op = fc.oneof({ weight: 4, arbitrary: fc.constantFrom(...OPS) }, hostile);

const leaf: fc.Arbitrary<unknown> = fc.oneof(
  fc.record({ field: name, op, value }, { requiredKeys: ['field', 'op'] }),
  // A hostile key next to a legal leaf.
  fc
    .tuple(hostile, fc.record({ field: name, op, value }))
    .map(([key, node]) => ({ ...node, [key]: 'x' })),
);

const tree = fc.letrec<{ node: unknown }>((tie) => ({
  node: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    leaf,
    fc.record({ and: fc.array(tie('node'), { minLength: 1, maxLength: 3 }) }),
    fc.record({ or: fc.array(tie('node'), { minLength: 1, maxLength: 3 }) }),
    fc.record({ not: tie('node') }),
  ),
})).node;

// Every string outside a value, with the place it sits.
function structuralStrings(node: FilterNode, out: string[]): void {
  for (const key of Object.keys(node)) out.push(key);
  if ('and' in node) {
    for (const child of node.and) structuralStrings(child, out);
  } else if ('or' in node) {
    for (const child of node.or) structuralStrings(child, out);
  } else if ('not' in node) {
    structuralStrings(node.not, out);
  } else {
    out.push(node.field, node.op);
  }
}

describe('filter fuzz', () => {
  it('lets customer text through only as a value, never as a name, key or operator', () => {
    fc.assert(
      fc.property(tree, (input) => {
        const result = parseFilterParam(SCHEMA, JSON.stringify(input));
        if (!result.ok) {
          // An error carries codes and positions, never the text that caused it.
          expect(JSON.stringify(result.error)).not.toContain(MARK);
          return;
        }
        const strings: string[] = [];
        structuralStrings(result.value, strings);
        for (const text of strings) {
          expect(text).not.toContain(MARK);
          expect(KEYS.has(text) || IDS.has(text) || OPS.includes(text)).toBe(true);
        }
        // What leaves here is the closed tree the engine compiles, parameters and all.
        expect(checkFilter(SCHEMA, result.value, { itemCount: 0 }).ok).toBe(true);
      }),
      { numRuns: 3000 },
    );
  });

  it('never throws on random JSON or random text', () => {
    fc.assert(
      fc.property(fc.oneof(fc.json(), fc.string({ maxLength: 200 })), (raw) => {
        const result = parseFilterParam(SCHEMA, raw);
        if (!result.ok) expect(result.error.code).toBe('api.filter_invalid');
      }),
      { numRuns: 3000 },
    );
  });

  it('maps every legal name to its id and nothing else', () => {
    fc.assert(
      fc.property(fc.constantFrom(...NAMES), (field) => {
        const result = parseFilterParam(SCHEMA, JSON.stringify({ field, op: 'exists' }));
        expect(result.ok).toBe(true);
        if (result.ok && 'field' in result.value) {
          const index = NAMES.indexOf(field);
          expect(result.value.field).toBe(SCHEMA.fields[index]?.id);
          expect(result.value.field).not.toBe(fid(15));
        }
      }),
    );
  });
});

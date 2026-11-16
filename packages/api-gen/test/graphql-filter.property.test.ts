import type { ContentSchema } from '@drefyn/schema';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseFilterParam } from '../src/index.ts';
import { emitWith, fakeStore, lastWhere, run } from './graphql-support.ts';
import { bool, date, number, schemaOf, text } from './support.ts';

const SCHEMA: ContentSchema = schemaOf([
  text(1, { apiName: 'title', filterable: true }),
  text(2, { apiName: 'body' }),
  number(3, { apiName: 'price', filterable: true }),
  bool(4, { apiName: 'live', filterable: true }),
  date(5, { apiName: 'at', filterable: true }),
]);

const OPS = ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists'] as const;

// Strings a field might accept, plus ones it must refuse, so both answers are exercised.
const word = fc.oneof(
  fc.constantFrom('a', 'hello', '12.50', '-3', '2026-01-01', '2026-01-01T00:00:00Z', ''),
  fc.string({ unit: 'grapheme', maxLength: 12 }),
);

const valueArb = fc.oneof(word, fc.boolean(), fc.array(word, { minLength: 0, maxLength: 4 }));

const leaf: fc.Arbitrary<Readonly<Record<string, unknown>>> = fc.record(
  {
    field: fc.constantFrom('title', 'body', 'price', 'live', 'at', 'nope'),
    op: fc.constantFrom(...OPS),
    value: valueArb,
  },
  { requiredKeys: ['field', 'op'] },
);

// Leaves that pass, so trees that compile are common and not a lucky few.
const SOUND: Readonly<Record<string, readonly unknown[]>> = {
  title: ['a', 'hello'],
  body: ['words'],
  price: ['12.50', '-3', '0'],
  live: [true, false],
  at: ['2026-01-01T00:00:00Z'],
};
const COMPARE = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'] as const;
const OPS_FOR: Readonly<Record<string, readonly string[]>> = {
  title: [...COMPARE, 'contains', 'in', 'exists'],
  body: ['contains', 'exists'],
  price: [...COMPARE, 'in', 'exists'],
  live: ['eq', 'neq', 'exists'],
  at: [...COMPARE, 'in', 'exists'],
};
const soundLeaf: fc.Arbitrary<Readonly<Record<string, unknown>>> = fc
  .constantFrom(...Object.keys(SOUND))
  .chain((field) =>
    fc
      .constantFrom(...(OPS_FOR[field] ?? []))
      .chain((op): fc.Arbitrary<Record<string, unknown>> => {
        const values = SOUND[field] ?? [];
        if (op === 'exists') return fc.constant({ field, op });
        const one = fc.constantFrom(...values);
        if (op === 'in') {
          return fc
            .array(
              one.filter((v) => typeof v === 'string'),
              { minLength: 1, maxLength: 3 },
            )
            .map((value) => ({ field, op, value }));
        }
        return one.map((value) => ({ field, op, value }));
      }),
  );

type Tree = Readonly<Record<string, unknown>>;

const treeArb: fc.Arbitrary<Tree> = fc.letrec<{ tree: Tree }>((tie) => ({
  tree: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.oneof({ weight: 4, arbitrary: soundLeaf }, { weight: 1, arbitrary: leaf }),
    fc.record({ and: fc.array(tie('tree'), { minLength: 1, maxLength: 3 }) }),
    fc.record({ or: fc.array(tie('tree'), { minLength: 1, maxLength: 3 }) }),
    fc.record({ not: tie('tree') }),
  ),
})).tree;

// A deep chain past the filter depth limit, and a tree with two kinds of node in one object.
const edgeArb: fc.Arbitrary<Tree> = fc.oneof(
  fc.integer({ min: 7, max: 12 }).map((depth) => {
    let tree: Tree = { field: 'title', op: 'eq', value: 'a' };
    for (let i = 0; i < depth; i += 1) tree = { not: tree };
    return tree;
  }),
  leaf.map((node) => ({ ...node, not: { field: 'live', op: 'exists' } })),
);

const anyTree = fc.oneof({ weight: 5, arbitrary: treeArb }, { weight: 1, arbitrary: edgeArb });

const ENUMS = new Set(['op']);

// The same tree written inline in the query, with field and op as enum values.
function literal(value: unknown, key = ''): string {
  if (Array.isArray(value)) return `[${value.map((item) => literal(item)).join(', ')}]`;
  if (typeof value === 'string') return ENUMS.has(key) ? value : JSON.stringify(value);
  if (typeof value === 'boolean') return String(value);
  const entries = Object.entries(value as Tree).map(([k, v]) => `${k}: ${literal(v, k)}`);
  return `{${entries.join(', ')}}`;
}

const VARIABLE_QUERY = `query List($where: _Where) {
  list_article(where: $where) { nextCursor }
}`;

async function viaGraphql(where: Tree, inline: boolean) {
  const store = fakeStore();
  const schema = emitWith([SCHEMA], store);
  const result = inline
    ? await run(schema, `{ list_article(where: ${literal(where)}) { nextCursor } }`)
    : await run(schema, VARIABLE_QUERY, { where });
  return { result, where: lastWhere(store) };
}

describe('GraphQL where agrees with the filter parameter', () => {
  it('gives an equal FilterNode or the same refusal, through variables and inline', async () => {
    await fc.assert(
      fc.asyncProperty(anyTree, fc.boolean(), async (tree, inline) => {
        const expected = parseFilterParam(SCHEMA, JSON.stringify(tree));
        const { result, where } = await viaGraphql(tree, inline);
        if (expected.ok) {
          expect(result.errors).toBeUndefined();
          expect(where).toEqual(expected.value);
        } else {
          expect(where).toBeUndefined();
          expect(result.errors).toEqual([
            expect.objectContaining({
              extensions: { code: 'api.filter_invalid', fields: expected.error.fields },
            }),
          ]);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('passes no filter when where is left out', async () => {
    const store = fakeStore();
    await run(emitWith([SCHEMA], store), '{ list_article { nextCursor } }');
    expect(lastWhere(store)).toBeNull();
  });
});

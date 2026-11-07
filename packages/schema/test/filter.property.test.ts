import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  checkFilter,
  parseFilterNode,
  UNDECLARED_FILTER_MAX_ITEMS,
  type FilterNode,
} from '../src/index.ts';
import { fid, number, schema, text } from './support.ts';

const declared = fid(1);
const undeclared = fid(2);
const type = schema([text(1, { filterable: true }), number(2)]);

const leaf = (field: typeof declared): FilterNode => ({ field, op: 'exists' });

const tree = (leaves: fc.Arbitrary<FilterNode>): fc.Arbitrary<FilterNode> =>
  fc.letrec<{ node: FilterNode }>((tie) => ({
    node: fc.oneof(
      { depthSize: 'small', withCrossShrink: true },
      leaves,
      fc.array(tie('node'), { minLength: 1, maxLength: 3 }).map((and) => ({ and })),
      fc.array(tie('node'), { minLength: 1, maxLength: 3 }).map((or) => ({ or })),
      tie('node').map((not) => ({ not })),
    ),
  })).node;

// Depth and node count are checked on their own; here a tree has to fit inside them.
const fits = (node: FilterNode): boolean => parseFilterNode(node).ok;

const mentions = (node: FilterNode, field: string): boolean => {
  if ('and' in node) return node.and.some((n) => mentions(n, field));
  if ('or' in node) return node.or.some((n) => mentions(n, field));
  if ('not' in node) return mentions(node.not, field);
  return node.field === field;
};

describe('text values', () => {
  // Raw UTF-16 units, as every other string arbitrary keeps surrogates in pairs.
  const units = fc.string({
    unit: fc.integer({ min: 0, max: 0xffff }).map((unit) => String.fromCharCode(unit)),
    maxLength: 32,
  });

  it('takes a value exactly when Postgres can hold it', () => {
    fc.assert(
      fc.property(units, (value) => {
        const result = checkFilter(type, { field: declared, op: 'eq', value }, { itemCount: 1 });
        expect(result.ok).toBe(value.isWellFormed() && !value.includes('\u0000'));
      }),
    );
  });
});

describe('filters', () => {
  it('runs a tree of declared fields at any size', () => {
    fc.assert(
      fc.property(
        tree(fc.constant(leaf(declared))),
        fc.nat({ max: 10_000_000 }),
        (filter, itemCount) => {
          fc.pre(fits(filter));
          expect(checkFilter(type, filter, { itemCount }).ok).toBe(true);
        },
      ),
    );
  });

  it('refuses any tree naming an undeclared field above the limit, and only those', () => {
    fc.assert(
      fc.property(
        tree(fc.constantFrom(leaf(declared), leaf(undeclared))),
        fc.integer({ min: 1, max: 1_000_000 }),
        (filter, extra) => {
          fc.pre(fits(filter));
          const over = { itemCount: UNDECLARED_FILTER_MAX_ITEMS + extra };
          const at = { itemCount: UNDECLARED_FILTER_MAX_ITEMS };
          const result = checkFilter(type, filter, over);
          if (mentions(filter, undeclared)) {
            expect(result).toMatchObject({ ok: false, error: { code: 'filter.not_declared' } });
          } else {
            expect(result.ok).toBe(true);
          }
          expect(checkFilter(type, filter, at).ok).toBe(true);
        },
      ),
    );
  });

  it('never throws on arbitrary input', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (input) => {
        expect(typeof checkFilter(type, input, { itemCount: 1 }).ok).toBe('boolean');
      }),
    );
  });
});

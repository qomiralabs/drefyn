import { randomUUID } from 'node:crypto';
import type { ContentSchema, FieldDef, FieldId, FilterNode, TypeId } from '@drefyn/schema';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compileFilter, type Route } from '../src/compile.ts';
import type { SlotMap } from '../src/filter-slots.ts';
import { compileProbe } from './support/compile-probe.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as FieldId;
const base = (n: number) => ({ id: id(n), apiName: `f${String(n)}`, label: 'F', required: false });

const TEXT: FieldDef = { ...base(1), kind: 'text', maxLength: 256, filterable: true };
const NUMBER: FieldDef = { ...base(2), kind: 'number', scale: 2, filterable: true };
const BOOLEAN: FieldDef = { ...base(3), kind: 'boolean', filterable: true };
const WHEN: FieldDef = { ...base(4), kind: 'date', withTime: true, filterable: true };
const TAGS: FieldDef = {
  ...base(5),
  kind: 'list',
  maxItems: 8,
  filterable: true,
  of: { ...base(105), kind: 'text', maxLength: 32 },
};
const SCANNED: FieldDef = { ...base(6), kind: 'text', maxLength: 4096 };
const FIELDS = [TEXT, NUMBER, BOOLEAN, WHEN, TAGS, SCANNED];

const SCHEMA: ContentSchema = {
  typeId: id(9000) as string as TypeId,
  apiName: 'item',
  version: 1,
  fields: FIELDS,
  deprecated: [],
  retired: [],
};

const SLOTS: SlotMap = {
  [id(1)]: { column: 't1', state: 'ready' },
  [id(2)]: { column: 'i1', state: 'ready' },
  [id(3)]: { column: 'i2', state: 'ready' },
  [id(4)]: { column: 'd1', state: 'ready' },
  [id(5)]: { column: 'l2', state: 'ready' },
};

// Text a hostile caller would send, wrapped so a leak into SQL text can be found by search.
const MARK = 'zqzqmark';
const hostile = fc
  .constantFrom(
    `'; drop table app.nodes; --`,
    `' or 1=1 --`,
    `$1`,
    `"t1"`,
    `\\`,
    `%_`,
    `${'$'}${'$'}`,
    `/* x */`,
    `app.current_org()`,
  )
  .map((text) => `${MARK}${text}`);

const number = fc.bigInt({ min: -1000n, max: 1000n }).map((n) => `${String(n)}.25`);
const when = fc.constantFrom('2026-01-01T00:00:00Z', '2025-06-01T12:30:00+02:00');

const leaf: fc.Arbitrary<FilterNode> = fc.oneof(
  fc.record({
    field: fc.constantFrom(id(1), id(6)),
    op: fc.constantFrom('eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains'),
    value: hostile,
  }) as fc.Arbitrary<FilterNode>,
  fc.record({
    field: fc.constant(id(1)),
    op: fc.constant('in'),
    value: fc.array(hostile, { minLength: 1, maxLength: 4 }),
  }) as fc.Arbitrary<FilterNode>,
  fc.record({
    field: fc.constant(id(2)),
    op: fc.constantFrom('eq', 'neq', 'gt', 'gte', 'lt', 'lte'),
    value: number,
  }) as fc.Arbitrary<FilterNode>,
  fc.record({
    field: fc.constant(id(3)),
    op: fc.constantFrom('eq', 'neq'),
    value: fc.boolean(),
  }) as fc.Arbitrary<FilterNode>,
  fc.record({
    field: fc.constant(id(4)),
    op: fc.constantFrom('eq', 'gt', 'lte'),
    value: when,
  }) as fc.Arbitrary<FilterNode>,
  fc.record({
    field: fc.constant(id(5)),
    op: fc.constantFrom('eq', 'neq'),
    value: hostile,
  }) as fc.Arbitrary<FilterNode>,
  fc.record({
    field: fc.constant(id(5)),
    op: fc.constant('in'),
    value: fc.array(hostile, { minLength: 1, maxLength: 3 }),
  }) as fc.Arbitrary<FilterNode>,
  fc.record({
    field: fc.constantFrom(id(1), id(2), id(5), id(6)),
    op: fc.constant('exists'),
  }) as fc.Arbitrary<FilterNode>,
);

const tree: fc.Arbitrary<FilterNode> = fc.letrec<{ node: FilterNode }>((self) => ({
  node: fc.oneof(
    { maxDepth: 4, depthIdentifier: 'filter' },
    leaf,
    fc.record({ and: fc.array(self('node'), { minLength: 1, maxLength: 3 }) }),
    fc.record({ or: fc.array(self('node'), { minLength: 1, maxLength: 3 }) }),
    fc.record({ not: self('node') }),
  ),
})).node;

const compiled = (filter: FilterNode, route: Route) => {
  const fields = new Map(SCHEMA.fields.map((field) => [field.id, field]));
  return compileProbe(compileFilter(filter, { fields, slots: SLOTS, route }));
};

// Everything the compiler can write itself. A value could only reach the text by being copied
// into it, and then a word here would not cover it.
const WORDS = new Set(
  `and or not coalesce false true null is distinct from any strpos lower int boolean
   text bigint timestamptz jsonb f n head_fields t1 i1 i2 d1 l2`.split(/\s+/),
);

function assertClosed(text: string): void {
  const stripped = text
    .replace(/\$[0-9]+/g, ' ')
    .replace(/::/g, ' ')
    .replace(/"/g, ' ')
    .replace(/->>|->|@>|&&|>=|<=|<>|[()=<>,.[\]]/g, ' ')
    .replace(/\b0\b/g, ' ');
  for (const word of stripped.split(/\s+/).filter((part) => part !== '')) {
    expect(WORDS.has(word), `${word} in ${text}`).toBe(true);
  }
}

describe('compileFilter', () => {
  it('never moves a value into SQL text, on either route', () => {
    fc.assert(
      fc.property(tree, fc.constantFrom<Route>('slots', 'scan'), (filter, route) => {
        // A filter that holds a scan only field cannot take the slot route.
        const usesScanned = JSON.stringify(filter).includes(id(6));
        const { text, parameters } = compiled(filter, usesScanned ? 'scan' : route);
        expect(text).not.toContain(MARK);
        expect(text).not.toContain(`'`);
        expect(text).not.toContain(';');
        expect(text).not.toContain('--');
        assertClosed(text);
        expect(text.includes('$') || parameters.length === 0).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('binds field ids in a scan, and a field id never joins the text', () => {
    const { text, parameters } = compiled({ field: id(6), op: 'eq', value: 'x' }, 'scan');
    expect(text).not.toContain(id(6));
    expect(parameters).toContain(id(6));
  });

  it('writes the same text for the same tree', () => {
    fc.assert(
      fc.property(tree, (filter) => {
        expect(compiled(filter, 'scan').text).toBe(compiled(filter, 'scan').text);
      }),
      { numRuns: 100 },
    );
  });

  it('turns missing into false under not, so not eq and neq agree', () => {
    const { text } = compiled({ not: { field: id(1), op: 'eq', value: 'x' } }, 'slots');
    expect(text).toContain('not coalesce(');
  });

  it('refuses a slot route for a field with no ready slot, whatever it was told', () => {
    expect(() => compiled({ field: id(6), op: 'eq', value: 'x' }, 'slots')).toThrow();
  });

  it('never concatenates a random uuid either', () => {
    const value = randomUUID();
    expect(compiled({ field: id(1), op: 'eq', value }, 'slots').text).not.toContain(value);
  });
});

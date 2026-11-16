import {
  asFieldId,
  asTypeId,
  type ContentSchema,
  type FieldDef,
  type FieldId,
  type TypeId,
} from '@drefyn/schema';
import fc from 'fast-check';

// FC_SEED replays every property under another seed without editing a file.
function seedFrom(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const seed = Number(raw);
  if (!/^-?[0-9]+$/.test(raw) || seed !== (seed | 0)) {
    throw new Error('FC_SEED must be a 32 bit integer');
  }
  return seed;
}

fc.configureGlobal({ seed: seedFrom(process.env['FC_SEED'], 285) });

const uuid = (kind: string, n: number): string =>
  `00000000-0000-7000-${kind}-${n.toString(16).padStart(12, '0')}`;

export function fid(n: number): FieldId {
  const id = asFieldId(uuid('8000', n));
  if (id === undefined) throw new Error('bad test id');
  return id;
}

export function tid(n: number): TypeId {
  const id = asTypeId(uuid('9000', n));
  if (id === undefined) throw new Error('bad test id');
  return id;
}

export const ORG = '0190a7b0-0000-7000-8000-000000000001';
export const PRJ = '0190a7b0-0000-7000-8000-000000000002';

export const EMPTY_TREE = {
  type: 'root',
  astVersion: 1,
  dialect: 'md',
  eol: 'lf',
  children: [],
  tail: '',
  tailOf: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
} as const;

type Extra = Partial<Omit<FieldDef, 'kind' | 'id'>>;

const base = (n: number, extra: Extra) => ({
  id: fid(n),
  apiName: `field${String(n)}`,
  label: `Field ${String(n)}`,
  required: false,
  ...extra,
});

export const text = (n: number, extra: Extra = {}, more: object = {}): FieldDef => ({
  ...base(n, extra),
  kind: 'text',
  maxLength: 64,
  ...more,
});
export const markdown = (n: number, extra: Extra = {}): FieldDef => ({
  ...base(n, extra),
  kind: 'markdown',
  maxLength: 1000,
});
export const richText = (n: number, extra: Extra = {}): FieldDef => ({
  ...base(n, extra),
  kind: 'rich_text',
});
export const number = (n: number, extra: Extra = {}, more: object = {}): FieldDef => ({
  ...base(n, extra),
  kind: 'number',
  scale: 2,
  ...more,
});
export const bool = (n: number, extra: Extra = {}): FieldDef => ({
  ...base(n, extra),
  kind: 'boolean',
});
export const date = (n: number, extra: Extra = {}, withTime = true): FieldDef => ({
  ...base(n, extra),
  kind: 'date',
  withTime,
});
export const asset = (n: number, extra: Extra = {}): FieldDef => ({
  ...base(n, extra),
  kind: 'asset',
  accept: ['image/png'],
});
export const reference = (n: number, many: boolean, extra: Extra = {}): FieldDef => ({
  ...base(n, extra),
  kind: 'reference',
  to: [tid(1)],
  many,
});
export const list = (n: number, of: FieldDef, maxItems = 4, extra: Extra = {}): FieldDef => ({
  ...base(n, extra),
  kind: 'list',
  of,
  maxItems,
});
export const object = (n: number, fields: readonly FieldDef[], extra: Extra = {}): FieldDef => ({
  ...base(n, extra),
  kind: 'object',
  fields,
});

export const schemaOf = (fields: readonly FieldDef[], over: Partial<ContentSchema> = {}) =>
  ({
    typeId: tid(1),
    apiName: 'article',
    version: 1,
    fields,
    deprecated: [],
    retired: [],
    ...over,
  }) satisfies ContentSchema;

// A field definition with a fresh id. Ids and API names are set by the caller, so a schema
// built from these is valid whatever order the fields come in.
type Shape = (n: number, name: string, required: boolean) => FieldDef;

const scalarShape: fc.Arbitrary<Shape> = fc.oneof(
  fc.record({ maxLength: fc.integer({ min: 1, max: 40 }) }).map(
    ({ maxLength }): Shape =>
      (n, apiName, required) =>
        text(n, { apiName, required }, { maxLength }),
  ),
  fc.constantFrom<Shape>(
    (n, apiName, required) => text(n, { apiName, required }, { format: 'slug' }),
    (n, apiName, required) => markdown(n, { apiName, required }),
    (n, apiName, required) => richText(n, { apiName, required }),
    (n, apiName, required) => bool(n, { apiName, required }),
    (n, apiName, required) => date(n, { apiName, required }, true),
    (n, apiName, required) => date(n, { apiName, required }, false),
    (n, apiName, required) => asset(n, { apiName, required }),
    (n, apiName, required) => reference(n, false, { apiName, required }),
    (n, apiName, required) => reference(n, true, { apiName, required }),
  ),
  fc
    .record({
      scale: fc.constantFrom(0, 1, 2, 3, 4, 5, 6),
      bounded: fc.boolean(),
    })
    .map(
      ({ scale, bounded }): Shape =>
        (n, apiName, required) =>
          number(n, { apiName, required }, bounded ? { scale, min: '-50', max: '50' } : { scale }),
    ),
);

interface Counter {
  next: number;
}

// Built from a plain description so ids come out in one pass after generation.
type Plan =
  | { readonly kind: 'scalar'; readonly shape: Shape }
  | { readonly kind: 'list'; readonly of: Shape; readonly maxItems: number }
  | { readonly kind: 'object'; readonly fields: readonly PlanField[] };

interface PlanField {
  readonly plan: Plan;
  readonly required: boolean;
}

const scalarPlan: fc.Arbitrary<Plan> = scalarShape.map((shape) => ({ kind: 'scalar', shape }));

const planArb: fc.Arbitrary<Plan> = fc.oneof(
  { weight: 6, arbitrary: scalarPlan },
  {
    weight: 1,
    arbitrary: fc
      .record({ of: scalarShape, maxItems: fc.integer({ min: 1, max: 4 }) })
      .map(({ of, maxItems }) => ({ kind: 'list' as const, of, maxItems })),
  },
  {
    weight: 1,
    arbitrary: fc
      .array(fc.record({ plan: scalarPlan, required: fc.boolean() }), {
        minLength: 1,
        maxLength: 3,
      })
      .map((fields) => ({ kind: 'object' as const, fields })),
  },
);

function realize(plan: Plan, apiName: string, required: boolean, counter: Counter): FieldDef {
  counter.next += 1;
  const n = counter.next;
  switch (plan.kind) {
    case 'scalar':
      return plan.shape(n, apiName, required);
    case 'list': {
      counter.next += 1;
      const element = plan.of(counter.next, 'item', false);
      return list(n, element, plan.maxItems, { apiName, required });
    }
    case 'object':
      return object(
        n,
        plan.fields.map((field, index) =>
          realize(field.plan, `sub${String(index)}`, field.required, counter),
        ),
        { apiName, required },
      );
  }
}

export const schemaArb: fc.Arbitrary<ContentSchema> = fc
  .array(fc.record({ plan: planArb, required: fc.boolean() }), { minLength: 1, maxLength: 8 })
  .map((plans) => {
    const counter: Counter = { next: 0 };
    return schemaOf(
      plans.map((field, index) =>
        realize(field.plan, `field${String(index)}`, field.required, counter),
      ),
    );
  });

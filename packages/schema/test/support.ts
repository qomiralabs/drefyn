import fc from 'fast-check';
import {
  asFieldId,
  asTypeId,
  type ContentSchema,
  type FieldDef,
  type FieldId,
  type TypeId,
} from '../src/index.ts';

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

type Extra = Partial<Pick<FieldDef, 'filterable' | 'sortable' | 'unique' | 'localized'>> & {
  readonly apiName?: string;
  readonly required?: boolean;
  readonly label?: string;
};

const base = (n: number, extra: Extra = {}) => ({
  id: fid(n),
  apiName: `field${n}`,
  label: `Field ${n}`,
  required: false,
  ...extra,
});

export const text = (n: number, extra: Extra = {}, maxLength = 200): FieldDef => ({
  ...base(n, extra),
  kind: 'text',
  maxLength,
});
export const number = (n: number, extra: Extra = {}): FieldDef => ({
  ...base(n, extra),
  kind: 'number',
  scale: 2,
});
export const date = (n: number, extra: Extra = {}): FieldDef => ({
  ...base(n, extra),
  kind: 'date',
  withTime: true,
});
export const bool = (n: number, extra: Extra = {}): FieldDef => ({
  ...base(n, extra),
  kind: 'boolean',
});
export const richText = (n: number, extra: Extra = {}): FieldDef => ({
  ...base(n, extra),
  kind: 'rich_text',
});
export const markdown = (n: number, extra: Extra = {}, maxLength = 10_000): FieldDef => ({
  ...base(n, extra),
  kind: 'markdown',
  maxLength,
});
export const asset = (n: number, extra: Extra = {}): FieldDef => ({
  ...base(n, extra),
  kind: 'asset',
  accept: ['image/png', 'image/*'],
});
export const reference = (
  n: number,
  to: readonly TypeId[] = [tid(1)],
  extra: Extra = {},
  many = false,
): FieldDef => ({ ...base(n, extra), kind: 'reference', to, many });
export const list = (n: number, of: FieldDef, extra: Extra = {}, maxItems = 32): FieldDef => ({
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

export const schema = (
  fields: readonly FieldDef[],
  extra: Partial<ContentSchema> = {},
): ContentSchema => ({
  typeId: tid(1),
  apiName: 'Article',
  version: 1,
  fields,
  deprecated: [],
  ...extra,
});

export const next = (
  prior: ContentSchema,
  fields: readonly FieldDef[] = prior.fields,
  deprecated: readonly FieldId[] = prior.deprecated,
): ContentSchema => ({ ...prior, version: prior.version + 1, fields, deprecated });

const scalar = (n: number): fc.Arbitrary<FieldDef> =>
  fc.oneof(
    fc.integer({ min: 1, max: 5_000 }).map((length) => text(n, {}, length)),
    fc.constant(number(n)),
    fc.constant(date(n)),
    fc.constant(bool(n)),
    fc.constant(richText(n)),
    fc.constant(markdown(n)),
    fc.constant(asset(n)),
    fc.constant(reference(n)),
    fc.constant(reference(n, [tid(1)], {}, true)),
    fc.constant(object(n, [text(n + 500)])),
    fc.constant(list(n, text(n + 500))),
  );

// Ids are the array position, so every generated schema has unique ids and names.
export const anySchema: fc.Arbitrary<ContentSchema> = fc
  .integer({ min: 1, max: 12 })
  .chain((size) => fc.tuple(...Array.from({ length: size }, (_, i) => scalar(i + 1))))
  .map((fields) => schema(fields));

import { z } from 'zod';
import { exceedsBudget } from './bounded.ts';
import { isUuid } from './ids.ts';
import { MAX_FIELD_DEPTH, MAX_FIELDS, MAX_ISSUES } from './limits.ts';
import type {
  ContentSchema,
  FieldDef,
  FieldId,
  Result,
  SchemaError,
  SchemaErrorCode,
  SchemaIssue,
  TypeId,
} from './types.ts';

// Each field level is two JSON levels, a list and an object, then a target or media type
// list inside the deepest field. Anything past that cannot be a legal schema.
const MAX_JSON_DEPTH = 2 * MAX_FIELD_DEPTH + 2;
// Well above the largest legal schema, where only cost matters.
const SCHEMA_BUDGET = {
  maxDepth: MAX_JSON_DEPTH,
  maxValues: 100 * MAX_FIELDS,
  maxChars: 1_048_576,
};

const MEDIA_TYPE = /^[a-z]+\/(?:\*|[a-z0-9][a-z0-9.+-]*)$/;

const fieldId = z.custom<FieldId>(isUuid);
const typeId = z.custom<TypeId>(isUuid);
const positive = z.number().int().min(1);
const noRepeats = (items: readonly unknown[]): boolean => new Set(items).size === items.length;

const common = {
  id: fieldId,
  apiName: z.string(),
  label: z.string().min(1),
  required: z.boolean(),
  unique: z.boolean().exactOptional(),
  filterable: z.boolean().exactOptional(),
  sortable: z.boolean().exactOptional(),
  localized: z.boolean().exactOptional(),
};

const fieldDef: z.ZodType<FieldDef> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.strictObject({
      ...common,
      kind: z.literal('text'),
      maxLength: positive,
      format: z.enum(['plain', 'slug', 'email', 'url']).exactOptional(),
    }),
    z.strictObject({ ...common, kind: z.literal('rich_text') }),
    z.strictObject({ ...common, kind: z.literal('markdown'), maxLength: positive }),
    z.strictObject({
      ...common,
      kind: z.literal('number'),
      scale: z.literal([0, 1, 2, 3, 4, 5, 6]),
      min: z.string().exactOptional(),
      max: z.string().exactOptional(),
    }),
    z.strictObject({ ...common, kind: z.literal('boolean') }),
    z.strictObject({ ...common, kind: z.literal('date'), withTime: z.boolean() }),
    z.strictObject({
      ...common,
      kind: z.literal('asset'),
      accept: z.array(z.string().regex(MEDIA_TYPE)).min(1),
    }),
    z.strictObject({
      ...common,
      kind: z.literal('reference'),
      to: z.array(typeId).refine(noRepeats),
      many: z.boolean(),
    }),
    z.strictObject({ ...common, kind: z.literal('list'), of: fieldDef, maxItems: positive }),
    z.strictObject({ ...common, kind: z.literal('object'), fields: z.array(fieldDef).min(1) }),
  ]),
);

const contentSchema: z.ZodType<ContentSchema> = z.strictObject({
  typeId,
  apiName: z.string(),
  version: positive,
  fields: z.array(fieldDef).min(1),
  deprecated: z.array(fieldId).refine(noRepeats),
});

export const failure = (issues: readonly SchemaIssue[]): { ok: false; error: SchemaError } => {
  const [first] = issues;
  return {
    ok: false,
    error: {
      code: first?.code ?? 'schema.malformed',
      issues: issues.slice(0, MAX_ISSUES),
    },
  };
};

const single = (code: SchemaErrorCode) => failure([{ path: '', code }]);

// Shape and cost only. Names and rules are validateSchema's, which takes this first.
export function parseContentSchema(input: unknown): Result<ContentSchema, SchemaError> {
  const miss = exceedsBudget(input, SCHEMA_BUDGET);
  if (miss !== null) return single(miss === 'depth' ? 'schema.too_deep' : 'schema.too_large');
  const parsed = contentSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  // zod's messages can quote input, so only the path and a fixed code go out.
  return failure(
    parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      code: 'schema.malformed' as const,
    })),
  );
}

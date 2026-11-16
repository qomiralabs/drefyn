import type { ContentSchema, FieldDef } from '@drefyn/schema';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compileValidator } from '../src/index.ts';
import { emitWith, fakeStore, itemId, run } from './graphql-support.ts';
import { schemaArb, validContent } from './support.ts';

// Values GraphQL's own types let through but the validator refuses, so the code has to come
// from the validator. A wrong JSON type never gets this far in GraphQL.
function badValue(field: FieldDef): fc.Arbitrary<unknown> | null {
  switch (field.kind) {
    case 'text':
      return fc.constantFrom('x'.repeat(field.maxLength + 1), 'a\u0000');
    case 'markdown':
      return fc.constant('a\u0000');
    case 'number':
      return fc.constantFrom('1.0000001', '1e2', '', '9999999999999999999999999999', ' 1');
    case 'date':
      return fc.constantFrom('2026-02-30', '2026-01-01T24:00:00Z', 'soon');
    case 'rich_text':
      return fc.constantFrom({ type: 'root' }, [], 'text');
    case 'asset':
      return fc.constantFrom('not-a-uuid', 'ABCDEF00-0000-7000-8000-000000000000');
    case 'reference':
      return field.many ? fc.constant(['x', itemId(1)]) : fc.constant('x');
    case 'list':
      return fc.constant(Array.from({ length: field.maxItems + 1 }, () => null));
    default:
      return null;
  }
}

const MUTATION = (type: ContentSchema) => `
  mutation Create($input: _Input_${type.apiName}!) {
    create_${type.apiName}(input: $input, idempotencyKey: "k") { id }
  }
`;

const cases = schemaArb.chain((schema) => {
  const breakable = schema.fields.filter((field) => badValue(field) !== null);
  const bad =
    breakable.length === 0
      ? fc.constant(null)
      : fc
          .constantFrom(...breakable)
          .chain((field) =>
            (badValue(field) ?? fc.constant(null)).map((value) => ({ field, value })),
          );
  return fc.record({
    schema: fc.constant(schema),
    content: validContent(schema.fields),
    bad,
    dropRequired: fc.boolean(),
  });
});

describe('GraphQL input agrees with compileValidator', () => {
  it('refuses with the same field codes, before the write resolver runs', async () => {
    await fc.assert(
      fc.asyncProperty(cases, async ({ schema, content, bad, dropRequired }) => {
        const dropped = dropRequired ? schema.fields.find((field) => field.required) : undefined;
        const input: Record<string, unknown> = Object.fromEntries(
          Object.entries(content.input).filter(([key]) => key !== dropped?.apiName),
        );
        if (bad !== null) input[bad.field.apiName] = bad.value;
        const expected = compileValidator(schema)(input);
        const store = fakeStore();
        const result = await run(emitWith([schema], store), MUTATION(schema), { input });
        if (expected.ok) {
          expect(result.errors).toBeUndefined();
          expect(store.calls.create).toEqual([expected.value]);
          return;
        }
        expect(store.calls.create).toEqual([]);
        expect(result.errors).toEqual([
          expect.objectContaining({
            extensions: { code: 'api.validation_failed', fields: expected.error },
          }),
        ]);
      }),
      { numRuns: 150 },
    );
  });

  it('hands valid content to the write resolver exactly as the validator stores it', async () => {
    const valid = schemaArb.chain((schema) =>
      validContent(schema.fields).map((content) => ({ schema, content })),
    );
    await fc.assert(
      fc.asyncProperty(valid, async ({ schema, content }) => {
        const store = fakeStore();
        const result = await run(emitWith([schema], store), MUTATION(schema), {
          input: content.input,
        });
        expect(result.errors).toBeUndefined();
        expect(store.calls.create).toEqual([content.stored]);
        expect(JSON.stringify(store.calls.create[0])).toBe(JSON.stringify(content.stored));
      }),
      { numRuns: 100 },
    );
  });
});

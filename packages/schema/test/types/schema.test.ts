// Checked by `pnpm typecheck`: each @ts-expect-error fails the build if the line below it
// starts to compile. The function body never runs; vitest only confirms the file loads.
import { describe, expect, it } from 'vitest';
import type { ContentSchema, FieldDef, FieldId, FilterNode, TypeId } from '../../src/index.ts';

declare const field: FieldId;
declare const type: TypeId;

function compileOnly(): void {
  // @ts-expect-error a plain string is not a field id
  const id: FieldId = 'title';

  // @ts-expect-error a type id is not a field id
  const crossed: FieldId = type;

  const base = { id: field, apiName: 'a', label: 'a', required: false };

  // @ts-expect-error scale stops at 6
  const scale: FieldDef = { ...base, kind: 'number', scale: 7 };

  // @ts-expect-error number bounds are decimal strings, never floats
  const bound: FieldDef = { ...base, kind: 'number', scale: 2, min: 1.5 };

  // @ts-expect-error a filter value is never a number
  const value: FilterNode = { field, op: 'gt', value: 1.5 };

  // @ts-expect-error the operator list is closed
  const op: FilterNode = { field, op: 'regex', value: 'a' };

  // @ts-expect-error a filter names a field id, not a customer string
  const name: FilterNode = { field: 'title', op: 'exists' };

  // @ts-expect-error nothing can be pushed onto a stored schema
  const mutate = (s: ContentSchema) => s.deprecated.push(field);

  void [id, crossed, scale, bound, value, op, name, mutate];
}

describe('schema types', () => {
  it('loads', () => {
    expect(compileOnly).toBeTypeOf('function');
  });
});

import type { ContentSchema, FieldDef } from '@drefyn/schema';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { emitOpenApi, type JsonValue } from '../src/index.ts';
import { schemaArb, tid } from './support.ts';

const OPTIONS = { serverUrl: 'https://api.example.test', title: 'Docs', schemaVersion: 3 };

// Several types with distinct names and ids, plus reference targets that point across them.
const projectArb = fc.array(schemaArb, { minLength: 1, maxLength: 5 }).map((schemas) =>
  schemas.map((schema, index): ContentSchema => ({
    ...schema,
    typeId: tid(index + 1),
    apiName: `type${String(index)}`,
    deprecated: schema.fields.filter((_, i) => i % 3 === 1).map((field) => field.id),
  })),
);

function shuffleField(field: FieldDef, order: () => number): FieldDef {
  switch (field.kind) {
    case 'object':
      return {
        ...field,
        fields: shuffled(
          field.fields.map((f) => shuffleField(f, order)),
          order,
        ),
      };
    case 'list':
      return { ...field, of: shuffleField(field.of, order) };
    case 'reference':
      return { ...field, to: shuffled(field.to, order) };
    case 'asset':
      return { ...field, accept: shuffled(field.accept, order) };
    default:
      return field;
  }
}

function shuffled<T>(items: readonly T[], order: () => number): T[] {
  return items
    .map((item) => ({ item, key: order() }))
    .sort((a, b) => a.key - b.key)
    .map(({ item }) => item);
}

// Rebuilt with keys in reverse order, so the emitter cannot lean on input key order either.
function reversedKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reversedKeys) as T;
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).reverse()) {
    out[key] = reversedKeys((value as Record<string, unknown>)[key]);
  }
  return out as T;
}

function shuffleProject(types: readonly ContentSchema[], seed: number): ContentSchema[] {
  let state = seed >>> 0 || 1;
  const order = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  return shuffled(
    types.map((type) =>
      reversedKeys({
        ...type,
        fields: shuffled(
          type.fields.map((field) => shuffleField(field, order)),
          order,
        ),
        deprecated: shuffled(type.deprecated, order),
      }),
    ),
    order,
  );
}

function keysSorted(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.every(keysSorted);
  if (value === null || typeof value !== 'object') return true;
  const keys = Object.keys(value);
  const sorted = [...keys].sort();
  return (
    keys.every((key, i) => key === sorted[i]) &&
    Object.values(value as Record<string, JsonValue>).every(keysSorted)
  );
}

describe('emitOpenApi determinism', () => {
  it('gives byte equal output under shuffled types, fields and lists', () => {
    fc.assert(
      fc.property(projectArb, fc.integer(), fc.integer(), (types, a, b) => {
        const first = JSON.stringify(emitOpenApi(shuffleProject(types, a), OPTIONS));
        const second = JSON.stringify(emitOpenApi(shuffleProject(types, b), OPTIONS));
        expect(second).toBe(first);
        expect(JSON.stringify(emitOpenApi(types, OPTIONS))).toBe(first);
      }),
      { numRuns: 200 },
    );
  });

  it('sorts keys at every level and leaves no value JSON cannot hold', () => {
    fc.assert(
      fc.property(projectArb, (types) => {
        const doc = emitOpenApi(types, OPTIONS) as unknown as JsonValue;
        expect(keysSorted(doc)).toBe(true);
        expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
      }),
      { numRuns: 200 },
    );
  });

  it('does not change the input it reads', () => {
    fc.assert(
      fc.property(projectArb, (types) => {
        const before = JSON.stringify(types);
        emitOpenApi(types, OPTIONS);
        expect(JSON.stringify(types)).toBe(before);
      }),
      { numRuns: 50 },
    );
  });
});

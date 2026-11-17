import type { ContentSchema, FieldDef } from '@drefyn/schema';
import fc from 'fast-check';
import { buildSchema, lexicographicSortSchema, printSchema } from 'graphql';
import { describe, expect, it } from 'vitest';
import { emitWith, fakeStore } from './graphql-support.ts';
import { schemaArb, tid } from './support.ts';

const sdl = (types: readonly ContentSchema[]) =>
  printSchema(lexicographicSortSchema(emitWith(types, fakeStore())));

// Fisher and Yates over a fixed list of draws, so fast-check can shrink a failing order.
function shuffle<T>(list: readonly T[], draws: readonly number[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = (draws[i % draws.length] ?? 0) % (i + 1);
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

function shuffleField(field: FieldDef, draws: readonly number[]): FieldDef {
  if (field.kind === 'object') {
    return { ...field, fields: shuffle(field.fields, draws).map((f) => shuffleField(f, draws)) };
  }
  if (field.kind === 'list') return { ...field, of: shuffleField(field.of, draws) };
  if (field.kind === 'reference') return { ...field, to: shuffle(field.to, draws) };
  return field;
}

// Several types that reference each other, with ids and names a project could hold.
const projectArb = fc.array(schemaArb, { minLength: 1, maxLength: 4 }).map((types) =>
  types.map((type, index): ContentSchema => ({
    ...type,
    typeId: tid(index + 1),
    apiName: `type${String(index)}`,
    deprecated: type.fields.filter((_, i) => i % 3 === 1).map((field) => field.id),
  })),
);

const draws = fc.array(fc.nat(), { minLength: 1, maxLength: 32 });

describe('sorted SDL', () => {
  it('is byte stable under shuffled types, fields, targets and deprecations', () => {
    fc.assert(
      fc.property(projectArb, draws, (types, order) => {
        const shuffled = shuffle(types, order).map((type) => ({
          ...type,
          fields: shuffle(type.fields, order).map((field) => shuffleField(field, order)),
          deprecated: shuffle(type.deprecated, order),
        }));
        expect(sdl(shuffled)).toBe(sdl(types));
      }),
      { numRuns: 100 },
    );
  });

  it('prints SDL that parses back to a valid schema with the same text', () => {
    fc.assert(
      fc.property(projectArb, (types) => {
        const text = sdl(types);
        expect(printSchema(lexicographicSortSchema(buildSchema(text)))).toBe(text);
      }),
      { numRuns: 50 },
    );
  });

  it('never carries a label a person typed', () => {
    fc.assert(
      fc.property(projectArb, (types) => {
        const labelled = types.map((type) => ({
          ...type,
          fields: type.fields.map((field) => ({ ...field, label: 'Secret label text' })),
        }));
        expect(sdl(labelled)).not.toContain('Secret label text');
      }),
      { numRuns: 20 },
    );
  });
});

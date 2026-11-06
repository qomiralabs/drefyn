import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { validateSchema, type ContentSchema, type FieldDef } from '../src/index.ts';
import { anySchema, bool, fid, idsOf, next, number, text } from './support.ts';

const NEW_FIELD = 9_000;

const shuffled = (s: ContentSchema, seed: number): ContentSchema => {
  const fields = [...s.fields];
  let state = seed;
  for (let i = fields.length - 1; i > 0; i -= 1) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    const j = state % (i + 1);
    const [a, b] = [fields[i], fields[j]];
    if (a === undefined || b === undefined) throw new Error('index');
    fields[i] = b;
    fields[j] = a;
  }
  return { ...s, fields };
};

const pick = (s: ContentSchema, index: number): FieldDef => {
  const field = s.fields[index % s.fields.length];
  if (field === undefined) throw new Error('index');
  return field;
};

describe('schema diff', () => {
  it('accepts adding an optional field as additive, and nothing else changes', () => {
    fc.assert(
      fc.property(anySchema, fc.nat(), (prior, position) => {
        const fields = [...prior.fields];
        fields.splice(position % (fields.length + 1), 0, text(NEW_FIELD));
        const result = validateSchema(next(prior, fields), prior);
        expect(result).toEqual({
          ok: true,
          value: {
            fromVersion: 1,
            toVersion: 2,
            additive: true,
            added: [fid(NEW_FIELD)],
            changed: [],
            deprecated: [],
            restored: [],
            removed: [],
          },
        });
      }),
    );
  });

  it('refuses removing any field in place', () => {
    fc.assert(
      fc.property(anySchema, fc.nat(), (prior, index) => {
        const gone = pick(prior, index);
        const fields = prior.fields.filter((f) => f !== gone);
        fc.pre(fields.length > 0);
        const result = validateSchema(next(prior, fields), prior);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe('schema.breaking_in_place');
      }),
    );
  });

  it('refuses retyping any field in place', () => {
    fc.assert(
      fc.property(anySchema, fc.nat(), (prior, index) => {
        const target = pick(prior, index);
        const swap = target.kind === 'boolean' ? text(1) : bool(1);
        const replacement: FieldDef = { ...swap, id: target.id, apiName: target.apiName };
        const fields = prior.fields.map((f) => (f === target ? replacement : f));
        const result = validateSchema(next(prior, fields), prior);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe('schema.breaking_in_place');
      }),
    );
  });

  it('keeps a field served from deprecation until a confirmed removal', () => {
    fc.assert(
      fc.property(anySchema, fc.nat(), (first, index) => {
        const target = pick(first, index);
        const deprecating = next(first, first.fields, [target.id]);
        const step = validateSchema(deprecating, first);
        expect(step.ok).toBe(true);
        expect(deprecating.fields).toContain(target);

        const without = deprecating.fields.filter((f) => f !== target);
        fc.pre(without.length > 0);
        const dropped = next(deprecating, without, [], idsOf(target));
        expect(validateSchema(dropped, deprecating).ok).toBe(false);

        const confirmed = validateSchema(dropped, deprecating, { confirmedRemovals: [target.id] });
        expect(confirmed.ok).toBe(true);
        if (confirmed.ok) expect(confirmed.value.removed).toContain(target.id);
      }),
    );
  });

  it('refuses any removed id coming back, at any later version', () => {
    fc.assert(
      fc.property(anySchema, fc.nat(), fc.nat({ max: 3 }), (first, index, gap) => {
        const target = pick(first, index);
        const kept = first.fields.filter((f) => f !== target);
        fc.pre(kept.length > 0);
        const deprecating = next(first, first.fields, [target.id]);
        let stored = next(deprecating, kept, [], idsOf(target));
        const step = validateSchema(stored, deprecating, { confirmedRemovals: [target.id] });
        expect(step.ok).toBe(true);
        for (let i = 0; i < gap; i += 1) stored = next(stored);

        const back: FieldDef = { ...number(NEW_FIELD), id: target.id };
        const result = validateSchema(next(stored, [...kept, back]), stored);
        expect(result).toMatchObject({
          ok: false,
          error: { code: 'schema.breaking_in_place' },
        });
      }),
    );
  });

  it('refuses swapping any list element, confirmed or not', () => {
    fc.assert(
      fc.property(anySchema, fc.boolean(), (first, confirm) => {
        const target = first.fields.find((f) => f.kind === 'list');
        fc.pre(target !== undefined);
        const element = target.of;
        const prior = { ...first, deprecated: [element.id] };
        const swapped: FieldDef = { ...target, of: number(NEW_FIELD) };
        const fields = prior.fields.map((f) => (f === target ? swapped : f));
        const result = validateSchema(
          next(prior, fields, [], idsOf(element)),
          prior,
          confirm ? { confirmedRemovals: [element.id] } : {},
        );
        expect(result).toMatchObject({
          ok: false,
          error: { code: 'schema.breaking_in_place' },
        });
      }),
    );
  });

  it('gives the same bytes for any field order', () => {
    fc.assert(
      fc.property(anySchema, fc.nat(), (prior, seed) => {
        const fields = [...prior.fields, text(NEW_FIELD), text(NEW_FIELD + 1)];
        const after = next(prior, fields);
        const a = validateSchema(after, prior);
        const b = validateSchema(shuffled(after, seed), shuffled(prior, seed + 1));
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      }),
    );
  });

  it('accepts every generated schema as a first version', () => {
    fc.assert(
      fc.property(anySchema, (s) => {
        expect(validateSchema(s, null).ok).toBe(true);
      }),
    );
  });

  it('never throws on arbitrary input', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (input) => {
        const result = validateSchema(input as unknown as ContentSchema, null);
        expect(typeof result.ok).toBe('boolean');
      }),
    );
  });

  it('never throws on a valid schema with one value replaced by junk', () => {
    fc.assert(
      fc.property(
        anySchema,
        fc.constantFrom('id', 'apiName', 'label', 'required', 'kind', 'scale', 'maxLength'),
        fc.jsonValue(),
        (s, key, junk) => {
          const [first, ...rest] = s.fields;
          const damaged = { ...s, fields: [{ ...first, [key]: junk }, ...rest] };
          const result = validateSchema(damaged as unknown as ContentSchema, null);
          expect(typeof result.ok).toBe('boolean');
        },
      ),
    );
  });
});

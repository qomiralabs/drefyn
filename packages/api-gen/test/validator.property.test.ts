import { canonicalInstant, validateSchema, type FieldDef } from '@drefyn/schema';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compileValidator, type FieldIssueCode } from '../src/index.ts';
import { date, schemaArb, schemaOf, tid, validContent } from './support.ts';

// A value the field must refuse, with the one code that says why.
function invalidValue(field: FieldDef): fc.Arbitrary<{ input: unknown; code: FieldIssueCode }> {
  const wrongType = fc
    .constantFrom<unknown>(17, {}, true)
    .filter((value) => !(field.kind === 'boolean' && typeof value === 'boolean'))
    .filter((value) => !(field.kind === 'object' && typeof value === 'object'));
  const typed = wrongType.map((input) => ({ input, code: 'field.type' as const }));
  switch (field.kind) {
    case 'text':
      return fc.oneof(
        typed,
        fc.constant({ input: 'x'.repeat(field.maxLength + 1), code: 'field.too_long' as const }),
        fc.constant({ input: 'a\u0000', code: 'field.text' as const }),
      );
    case 'number':
      return fc.oneof(
        typed,
        fc.constant({ input: '1.0000001', code: 'field.number' as const }),
        fc.constant({ input: '1e2', code: 'field.number' as const }),
      );
    case 'date':
      return fc.oneof(typed, fc.constant({ input: '2026-02-30', code: 'field.date' as const }));
    case 'rich_text':
      return fc.constant({ input: { type: 'root' }, code: 'field.rich_text' as const });
    case 'list':
      return fc.oneof(
        fc.constant({ input: 'x', code: 'field.type' as const }),
        fc.constant({
          input: Array.from({ length: field.maxItems + 1 }, () => null),
          code: 'field.too_many' as const,
        }),
      );
    default:
      return typed;
  }
}

describe('compileValidator over random schemas', () => {
  it('generates only schemas the schema rules accept', () => {
    fc.assert(
      fc.property(schemaArb, (schema) => {
        expect(validateSchema(schema, null, { knownTypes: new Set([tid(1)]) }).ok).toBe(true);
      }),
    );
  });

  it('accepts valid content and returns it keyed by id in sorted order', () => {
    const cases = schemaArb.chain((schema) =>
      validContent(schema.fields).map((content) => ({ schema, content })),
    );
    fc.assert(
      fc.property(cases, ({ schema, content }) => {
        const result = compileValidator(schema)(content.input);
        expect(result).toEqual({ ok: true, value: content.stored });
        if (result.ok) expect(JSON.stringify(result.value)).toBe(JSON.stringify(content.stored));
      }),
      { numRuns: 150 },
    );
  });

  it('refuses one bad field with its own path and code', () => {
    const cases = schemaArb.chain((schema) =>
      fc.constantFrom(...schema.fields).chain((field) =>
        fc.record({
          schema: fc.constant(schema),
          field: fc.constant(field),
          content: validContent(schema.fields),
          bad: invalidValue(field),
        }),
      ),
    );
    fc.assert(
      fc.property(cases, ({ schema, field, content, bad }) => {
        const input = { ...content.input, [field.apiName]: bad.input };
        const result = compileValidator(schema)(input);
        expect(result).toEqual({ ok: false, error: [{ path: field.apiName, code: bad.code }] });
      }),
      { numRuns: 150 },
    );
  });

  it('reports a missing required field and an unknown key', () => {
    fc.assert(
      fc.property(schemaArb, (schema) => {
        const result = compileValidator(schema)({ notAField: 1 });
        const required = schema.fields
          .filter((field) => field.required)
          .map((field) => ({ path: field.apiName, code: 'field.required' }));
        const expected = [{ path: 'notAField', code: 'field.unknown' }, ...required].sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
        );
        expect(result).toEqual({ ok: false, error: expected });
      }),
    );
  });
});

// The edges where a date check drifts: shifts into year 0000 or past 9999, leap days, hour 24,
// leap seconds, offsets out of range, and missing parts.
const EDGE_DATES = [
  '0000-01-01',
  '0001-01-01',
  '0001-01-01T00:30:00+01:00',
  '0001-01-01T00:00:00Z',
  '9999-12-31',
  '9999-12-31T23:30:00-01:00',
  '9999-12-31T23:59:59Z',
  '2024-02-29',
  '2023-02-29',
  '2024-02-29T12:00:00Z',
  '2026-13-01',
  '2026-00-10',
  '2026-01-00',
  '2026-01-01T24:00:00Z',
  '2026-06-30T23:59:60Z',
  '2026-01-01T00:00:00+24:00',
  '2026-01-01T00:00:00+14:00',
  '2026-01-01T00:00:00',
  '2026-01-01T00:00:00.123456789Z',
  '2026-01-01t00:00:00z',
  '2026-1-1',
  ' 2026-01-01',
  '+002026-01-01',
  '',
];

describe('dates follow canonicalInstant exactly', () => {
  const dated = (withTime: boolean) => compileValidator(schemaOf([date(1, {}, withTime)]));

  it.each(EDGE_DATES)('agrees on %j', (value) => {
    for (const withTime of [true, false]) {
      const result = dated(withTime)({ field1: value });
      expect(result.ok).toBe(canonicalInstant(value, withTime) !== null);
    }
  });

  it('agrees on random strings shaped like dates', () => {
    const digits = (n: number) => fc.stringMatching(new RegExp(`^[0-9]{${String(n)}}$`));
    const shaped = fc
      .tuple(
        digits(4),
        digits(2),
        digits(2),
        digits(2),
        digits(2),
        fc.constantFrom('Z', '+05:30', '-12:00', ''),
      )
      .chain(([y, m, d, h, min, zone]) =>
        fc.constantFrom(`${y}-${m}-${d}`, `${y}-${m}-${d}T${h}:${min}:00${zone}`),
      );
    fc.assert(
      fc.property(fc.oneof(shaped, fc.string()), fc.boolean(), (value, withTime) => {
        const result = dated(withTime)({ field1: value });
        expect(result.ok).toBe(canonicalInstant(value, withTime) !== null);
      }),
      { numRuns: 2000 },
    );
  });
});

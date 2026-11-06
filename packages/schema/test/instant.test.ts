import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalInstant } from '../src/index.ts';

const CANONICAL = /^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

const digits = (value: number, width: number) => String(value).padStart(width, '0');

// Every date the format check could pass, with years and offsets weighted to the two edges, as
// those are the only places a shift can leave what Postgres reads.
const instants = fc
  .record({
    year: fc.oneof(
      fc.integer({ min: 0, max: 2 }),
      fc.integer({ min: 9998, max: 9999 }),
      fc.integer({ min: 0, max: 9999 }),
    ),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 31 }),
    hour: fc.integer({ min: 0, max: 23 }),
    fraction: fc.constantFrom('', '.1', '.123', '.123456789012'),
    offset: fc.constantFrom('Z', '+00:00', '-00:01', '+00:01', '+14:00', '-23:59', '+23:59'),
  })
  .map(
    ({ year, month, day, hour, fraction, offset }) =>
      `${digits(year, 4)}-${digits(month, 2)}-${digits(day, 2)}T${digits(hour, 2)}:00:00${fraction}${offset}`,
  );

describe('canonicalInstant', () => {
  it('never throws, whatever it is given', () => {
    fc.assert(
      fc.property(fc.anything(), fc.boolean(), (value, withTime) => {
        expect(canonicalInstant(value, withTime)).toBeNull();
      }),
    );
  });

  it('answers null or one form Postgres can read, for any time and offset', () => {
    fc.assert(
      fc.property(instants, (value) => {
        expect(canonicalInstant(value, true) ?? '0001-01-01T00:00:00.000Z').toMatch(CANONICAL);
      }),
    );
  });

  it('gives the same answer to the same instant, however it was written', () => {
    expect(canonicalInstant('2026-01-01T02:00:00+02:00', true)).toBe(
      canonicalInstant('2026-01-01T00:00:00Z', true),
    );
  });

  it('holds both ends of the years Postgres reads', () => {
    expect(canonicalInstant('0001-01-01T00:00:00Z', true)).toBe('0001-01-01T00:00:00.000Z');
    expect(canonicalInstant('0001-01-01T00:00:00+00:01', true)).toBeNull();
    expect(canonicalInstant('9999-12-31T23:59:59Z', true)).toBe('9999-12-31T23:59:59.000Z');
    expect(canonicalInstant('9999-12-31T23:59:59-00:01', true)).toBeNull();
  });
});

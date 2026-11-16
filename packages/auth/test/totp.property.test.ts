import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { matchTotp, totpCode } from '../src/index.ts';
import { runs } from './support.ts';

const secret = fc.uint8Array({ minLength: 20, maxLength: 20 });
// Around today's step and far beyond it.
const now = fc.integer({ min: 1, max: 2 ** 40 });
const outside = fc.oneof(fc.integer({ min: 1, max: 1000 }), fc.integer({ min: -1000, max: -2 }));

describe('matchTotp properties', () => {
  it('refuses a code from any step outside the current and previous one', () => {
    fc.assert(
      fc.property(secret, now, outside, (key, current, offset) => {
        fc.pre(current + offset >= 0);
        const typed = totpCode(key, current + offset);
        // A six digit code repeats by chance about once in a million steps; that is a match
        // on the step that really shows it, not a window leak.
        fc.pre(typed !== totpCode(key, current) && typed !== totpCode(key, current - 1));
        expect(matchTotp(key, typed, current)).toBeNull();
      }),
      runs,
    );
  });

  it('refuses any input that is not one of the two live codes', () => {
    fc.assert(
      fc.property(secret, now, fc.string({ maxLength: 16 }), (key, current, typed) => {
        const live = new Set([totpCode(key, current), totpCode(key, current - 1)]);
        fc.pre(!live.has(typed.replace(/\s/g, '')));
        expect(matchTotp(key, typed, current)).toBeNull();
      }),
      runs,
    );
  });

  it('accepts the two live codes and answers with the step that made them', () => {
    fc.assert(
      fc.property(secret, now, fc.constantFrom(0, -1), (key, current, offset) => {
        const matched = matchTotp(key, totpCode(key, current + offset), current);
        expect(matched === current || matched === current + offset).toBe(true);
        expect(matched).not.toBeNull();
      }),
      runs,
    );
  });
});

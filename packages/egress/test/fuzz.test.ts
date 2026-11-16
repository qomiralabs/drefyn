import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { classifyAddress } from '../src/address.ts';
import { policyFor } from '../src/policy.ts';
import { checkTarget } from '../src/target.ts';
import {
  dotted,
  v4Arbitrary,
  v4IsPublic,
  v6Arbitrary,
  v6IsPublic,
  v6Spellings,
} from '../fuzz/oracle.ts';
import { fuzz } from '../fuzz/target.ts';

describe('the fuzz target', () => {
  it('finishes a short run with nothing to report', () => {
    const report = fuzz({ seconds: 1, seed: 7 });
    expect(report.failure).toBeUndefined();
    expect(report.runs).toBeGreaterThan(0);
  });

  it('would catch a check that fails', () => {
    const report = fuzz({ seconds: 1, seed: 7, check: (url) => !url.includes('/') });
    expect(report.failure).toBeDefined();
  });
});

describe('address parsing properties', () => {
  it('agrees with the numeric oracle on every IPv4 address, plain and mapped', () => {
    fc.assert(
      fc.property(v4Arbitrary, (value) => {
        const pub = v4IsPublic(value);
        expect(classifyAddress(dotted(value))?.addressClass === 'unicast').toBe(pub);
        expect(classifyAddress(`::ffff:${dotted(value)}`)?.addressClass === 'unicast').toBe(pub);
      }),
      { numRuns: 2_000 },
    );
  });

  it('agrees with the numeric oracle on IPv6 addresses in every spelling', () => {
    fc.assert(
      fc.property(v6Arbitrary, (groups) => {
        for (const spelling of v6Spellings(groups)) {
          expect(classifyAddress(spelling)?.addressClass === 'unicast', spelling).toBe(
            v6IsPublic(groups),
          );
        }
      }),
      { numRuns: 2_000 },
    );
  });

  it('never throws on any string as a URL', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 60 }), (text) => {
        const result = checkTarget(text, policyFor('monitor'));
        expect(typeof result.ok).toBe('boolean');
      }),
      { numRuns: 2_000 },
    );
  });
});

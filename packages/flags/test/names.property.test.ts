import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FLAG_AREAS, FlagError, defineFlags, type FlagDefinition } from '../src/index.ts';
import { SEEDS } from './support/seeds.ts';

const NAME = /^[a-z]+\.[a-z][a-z0-9_]*$/;
const AREAS = new Set<string>(FLAG_AREAS);

const base = {
  kind: 'release',
  owner: 'Divine572',
  description: 'Fuzzed.',
  created: '2026-10-01',
  removeBy: '2027-03-01',
  safeValue: false,
} as const;

function outcome(definition: Record<string, unknown>): 'accepted' | FlagError {
  try {
    defineFlags([definition] as unknown as readonly FlagDefinition[]);
    return 'accepted';
  } catch (error) {
    if (error instanceof FlagError) return error;
    throw error;
  }
}

function expected(name: string): 'accepted' | 'name_pattern' | 'unknown_area' {
  if (!NAME.test(name)) return 'name_pattern';
  return AREAS.has(name.slice(0, name.indexOf('.'))) ? 'accepted' : 'unknown_area';
}

// Mostly near misses: real areas and plausible features, then one character changed.
const nearName = fc
  .tuple(
    fc.oneof(fc.constantFrom(...FLAG_AREAS), fc.stringMatching(/^[a-z]{1,9}$/)),
    fc.stringMatching(/^[a-z][a-z0-9_]{0,12}$/),
  )
  .map(([area, feature]) => `${area}.${feature}`);

const mutated = fc
  .tuple(nearName, fc.nat(), fc.string({ minLength: 0, maxLength: 2, unit: 'binary' }))
  .map(([name, at, insert]) => {
    const i = at % (name.length + 1);
    return name.slice(0, i) + insert + name.slice(i);
  });

const anyName = fc.oneof(nearName, mutated, fc.string({ unit: 'binary' }));

describe.each(SEEDS)('flag names, seed %i', (seed) => {
  it('are accepted exactly when they match <area>.<feature> with a known area', () => {
    const seen = { accepted: 0, name_pattern: 0, unknown_area: 0 };
    fc.assert(
      fc.property(anyName, (name) => {
        const want = expected(name);
        seen[want] += 1;
        const got = outcome({ ...base, name });
        if (want === 'accepted') {
          expect(got).toBe('accepted');
        } else {
          expect(got).toBeInstanceOf(FlagError);
          expect((got as FlagError).code).toBe('FLAG_DEFINITION_INVALID');
          expect((got as FlagError).problem).toBe(want);
        }
      }),
      { seed, numRuns: 400 },
    );
    // Guards against a generator that never reaches one of the branches.
    expect(seen.accepted).toBeGreaterThan(0);
    expect(seen.name_pattern).toBeGreaterThan(0);
    expect(seen.unknown_area).toBeGreaterThan(0);
  });
});

const isoDay = fc
  .date({
    min: new Date('2000-01-01T00:00:00Z'),
    max: new Date('2100-12-31T00:00:00Z'),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString().slice(0, 10));

describe.each(SEEDS)('removal dates, seed %i', (seed) => {
  it('are accepted exactly when removeBy is a later day than created', () => {
    const seen = { later: 0, notLater: 0 };
    fc.assert(
      fc.property(
        isoDay,
        isoDay,
        fc.constantFrom('release', 'experiment'),
        (created, removeBy, kind) => {
          const definition =
            kind === 'release'
              ? { ...base, name: 'status.sms', created, removeBy }
              : { ...base, kind, name: 'site.hero_copy', created, removeBy, metric: 'Signups' };
          const got = outcome(definition);
          if (removeBy > created) {
            seen.later += 1;
            expect(got).toBe('accepted');
          } else {
            seen.notLater += 1;
            expect(got).toBeInstanceOf(FlagError);
            expect((got as FlagError).problem).toBe('remove_by_not_after_created');
          }
        },
      ),
      // Biased toward equal and adjacent days, where an off by one would hide.
      {
        seed,
        numRuns: 300,
        examples: [
          ['2026-10-01', '2026-10-01', 'release'],
          ['2026-10-02', '2026-10-01', 'experiment'],
        ],
      },
    );
    expect(seen.later).toBeGreaterThan(0);
    expect(seen.notLater).toBeGreaterThan(0);
  });
});

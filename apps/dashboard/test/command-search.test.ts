import { permissionsFor } from '@drefyn/auth/permissions';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { startIncidentCommand } from '../src/incident/feed.ts';
import { commandFilter, type Command } from '../src/shell/commands.ts';
import { places, visiblePlaces } from '../src/shell/places.ts';

const SEED = 20261105;
const PROJECTS = {
  'docs/payments-api': { name: 'Payments API docs', product: 'docs' },
  'docs/cafe': { name: 'Café Münster', product: 'docs' },
  'status/acme-status': { name: 'Acme status', product: 'status' },
  'studio/handbook': { name: 'Handbook', product: 'studio' },
} as const;

const entry = (name: string, keywords?: readonly string[]): Command => ({
  id: 'entry',
  name,
  kind: 'Docs project',
  icon: 'page',
  ...(keywords === undefined ? {} : { keywords }),
  href: '/acme/entry',
  permission: 'org.read',
});

// The same call the autocomplete makes, row text and all.
const search = (entries: readonly Command[], query: string): readonly string[] => {
  const filter = commandFilter(entries);
  return entries
    .filter((e) => filter(`${e.name}, ${e.kind}`, query, { key: e.id }))
    .map((e) => e.id);
};

describe('every registry entry is reachable by search', () => {
  const owner = permissionsFor('owner', new Set(['docs', 'studio', 'status']));
  const actions = [startIncidentCommand('acme')];
  const registry = visiblePlaces('acme', owner, PROJECTS, actions);

  it('covers the whole registry, not a part of it', () => {
    expect(registry).toEqual([...places('acme', PROJECTS), ...actions]);
    expect(registry.length).toBeGreaterThan(10);
  });

  it.each(registry.map((e) => [e.name, e] as const))('%s by its name', (name, target) => {
    expect(search(registry, name)).toContain(target.id);
  });

  it.each(registry.flatMap((e) => (e.keywords ?? []).map((word) => [word, e] as const)))(
    'by the keyword %s',
    (word, target) => {
      expect(search(registry, word)).toContain(target.id);
    },
  );

  it('finds a project typed without its accents', () => {
    expect(search(registry, 'cafe munster')).toEqual(['project-docs/cafe']);
  });
});

describe('what search refuses', () => {
  const registry = places('acme', PROJECTS);

  it('leaves out a query nothing holds', () => {
    expect(search(registry, 'zzzz')).toEqual([]);
  });

  it('keeps everything on an empty query, however it is spelled', () => {
    for (const query of ['', '   ', '\t\n', ' ', '́']) {
      expect(search(registry, query)).toHaveLength(registry.length);
    }
  });

  it('reads a key it was never given from the row text', () => {
    const filter = commandFilter([]);
    expect(filter('Café, product', 'cafe', { key: 'unknown' })).toBe(true);
    expect(filter('Café, product', 'tea', { key: 'unknown' })).toBe(false);
  });
});

const LETTERS = ['a', 'e', 'o', 'n', 'S', 'I', 'k', 'é', 'ü', 'ñ', 'ß', 'Ø', 'İ', 'ı', 'Σ', 'ς'];
const SPACES = [' ', '  ', '\t', ' ', ' ', ' \n '];

const letters = fc.array(fc.constantFrom(...LETTERS), { minLength: 1, maxLength: 8 });
const word = letters.map((chosen) => chosen.join(''));
const words = fc.array(word, { minLength: 1, maxLength: 4 });
const respaced = (parts: readonly string[], gap: string) => parts.join(gap);
const spoken = (parts: readonly string[]) => parts.join(' ');
const marksRemoved = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '');

describe('search over generated names', () => {
  const found = (name: string, query: string) => {
    expect(search([entry(name)], query), JSON.stringify({ name, query })).toEqual(['entry']);
  };

  it('finds any name typed as written', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'grapheme', minLength: 1, maxLength: 24 }).filter((s) => s.trim() !== ''),
        (name) => {
          found(name, name);
        },
      ),
      { seed: SEED, numRuns: 500 },
    );
  });

  it('ignores case', () => {
    fc.assert(
      fc.property(words, (parts) => {
        const name = spoken(parts);
        found(name, name.toUpperCase());
        found(name, name.toLowerCase());
        found(name.toUpperCase(), name);
      }),
      { seed: SEED, numRuns: 500 },
    );
  });

  it('ignores spacing, on either side', () => {
    fc.assert(
      fc.property(words, fc.constantFrom(...SPACES), (parts, gap) => {
        found(spoken(parts), `  ${respaced(parts, gap)}\t`);
        found(respaced(parts, gap), spoken(parts));
      }),
      { seed: SEED, numRuns: 500 },
    );
  });

  it('ignores how accents were typed, and whether they were', () => {
    fc.assert(
      fc.property(words, (parts) => {
        const name = spoken(parts);
        found(name.normalize('NFC'), name.normalize('NFD'));
        found(name.normalize('NFD'), name.normalize('NFC'));
        found(name, marksRemoved(name));
      }),
      { seed: SEED, numRuns: 500 },
    );
  });

  it('finds a part of a name, cut on any letter', () => {
    fc.assert(
      fc.property(letters, fc.nat(), fc.nat(), (chosen, a, b) => {
        const start = a % chosen.length;
        const end = start + 1 + (b % (chosen.length - start));
        found(chosen.join(''), chosen.slice(start, end).join(''));
      }),
      { seed: SEED, numRuns: 500 },
    );
  });

  it('never finds a query with a letter the entry does not hold', () => {
    fc.assert(
      fc.property(words, (parts) => {
        expect(search([entry(spoken(parts))], `${spoken(parts)}zq`)).toEqual([]);
      }),
      { seed: SEED, numRuns: 500 },
    );
  });

  it('reaches keywords the same way as names', () => {
    fc.assert(
      fc.property(word, (keyword) => {
        expect(search([entry('Row', [keyword])], marksRemoved(keyword).toUpperCase())).toEqual([
          'entry',
        ]);
      }),
      { seed: SEED, numRuns: 500 },
    );
  });
});

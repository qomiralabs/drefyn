import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseMigrationFile } from '../src/migration-file.ts';
import { MigrateError } from '../src/outcome.ts';
import { migrationText, utf8 } from './support.ts';

const params = { seed: 1414, numRuns: 300 };

// SQL like lines: never a line comment, never a marker, never non transactional.
const statement = fc
  .stringMatching(/^[a-z][a-z0-9_ ]{0,40};$/)
  .filter((s) => !/concurrently/i.test(s));
const body = fc.array(statement, { minLength: 1, maxLength: 5 }).map((lines) => lines.join('\n'));

describe('migration file properties', () => {
  it('keeps each body in its own section', () => {
    fc.assert(
      fc.property(body, body, (up, down) => {
        const file = parseMigrationFile('1760000000000_p.sql', utf8(migrationText(up, down)));
        expect(file.up).toContain(up);
        expect(file.down).toContain(down);
      }),
      params,
    );
  });

  it('hashes with SHA-256 over the bytes', () => {
    fc.assert(
      fc.property(body, body, (up, down) => {
        const text = migrationText(up, down);
        const file = parseMigrationFile('1760000000000_p.sql', utf8(text));
        expect(file.sha256).toBe(createHash('sha256').update(text).digest('hex'));
      }),
      params,
    );
  });

  it('changes the hash when any byte changes', () => {
    fc.assert(
      fc.property(body, body, fc.nat(), (up, down, at) => {
        const bytes = utf8(migrationText(up, down));
        const edited = Uint8Array.from(bytes);
        const i = at % edited.length;
        // Swap one ASCII letter or digit for another, so the file still parses.
        const c = edited[i] ?? 0;
        if (!/[a-z0-9]/.test(String.fromCharCode(c))) return;
        edited[i] = c === 0x61 ? 0x62 : 0x61;
        const a = parseMigrationFile('1760000000000_p.sql', bytes);
        let b;
        try {
          b = parseMigrationFile('1760000000000_p.sql', edited);
        } catch (error) {
          expect(error).toBeInstanceOf(MigrateError);
          return;
        }
        expect(b.sha256).not.toBe(a.sha256);
      }),
      params,
    );
  });

  it('refuses any file once its down marker is removed', () => {
    fc.assert(
      fc.property(body, body, (up, down) => {
        const text = migrationText(up, down).replace('-- Down Migration\n', '');
        expect(() => parseMigrationFile('1760000000000_p.sql', utf8(text))).toThrow(MigrateError);
      }),
      params,
    );
  });

  // Fuzz: arbitrary text either parses into two non empty sections or is refused with a
  // MigrateError; nothing else escapes. 1000 runs took 216 to 249 ms alone and 439 to 635 ms
  // beside two other suites on an M-series laptop, and 6349 ms on a loaded review machine
  // (427 ms alone there). 30 s keeps about 4.7 times the worst seen.
  it('never throws anything but a MigrateError', { timeout: 30_000 }, () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 400 }), (text) => {
        try {
          const file = parseMigrationFile('1760000000000_p.sql', utf8(text));
          expect(file.up.trim()).not.toBe('');
          expect(file.down.trim()).not.toBe('');
        } catch (error) {
          expect(error).toBeInstanceOf(MigrateError);
        }
      }),
      { seed: 1414, numRuns: 1000 },
    );
  });
});

// The recorded name is interpolated into SQL by the migration tool, so the name rule is a
// security rule: a name is accepted exactly when it matches it, and nothing near it passes.
const STRICT_NAME = /^[0-9]{13}_[a-z0-9]+(_[a-z0-9]+)*\.sql$/;

const nearName = fc
  .tuple(
    fc.stringMatching(/^[0-9]{11,15}$/),
    fc.constantFrom('_', '-', '__', ''),
    fc.stringMatching(/^[a-zA-Z0-9_' ;.-]{0,16}$/),
    fc.constantFrom('.sql', '.SQL', '.sql.js', '.js', '.ts', '.mjs', '.cjs', '.json', ''),
  )
  .map(([digits, sep, words, ext]) => `${digits}${sep}${words}${ext}`);

const anyName = fc.oneof(
  nearName,
  fc.string({ maxLength: 40 }).map((s) => `${s}.sql`),
  fc.string({ unit: 'grapheme', maxLength: 40 }),
);

describe('migration file name properties', () => {
  it('accepts a name exactly when it matches the strict rule', () => {
    const text = utf8(migrationText('select 1;', 'select 1;'));
    fc.assert(
      fc.property(anyName, (name) => {
        if (STRICT_NAME.test(name)) {
          expect(parseMigrationFile(name, text).name).toBe(name);
        } else {
          expect(() => parseMigrationFile(name, text)).toThrow(MigrateError);
        }
      }),
      { seed: 1414, numRuns: 1000 },
    );
  });

  it('accepts every name the rule allows', () => {
    const strict = fc
      .tuple(
        fc.stringMatching(/^[0-9]{13}$/),
        fc.array(fc.stringMatching(/^[a-z0-9]{1,8}$/), { minLength: 1, maxLength: 4 }),
      )
      .map(([digits, words]) => `${digits}_${words.join('_')}.sql`);
    const text = utf8(migrationText('select 1;', 'select 1;'));
    fc.assert(
      fc.property(strict, (name) => {
        expect(parseMigrationFile(name, text).name).toBe(name);
      }),
      params,
    );
  });
});

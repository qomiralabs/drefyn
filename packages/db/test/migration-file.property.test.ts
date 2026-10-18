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
  // MigrateError; nothing else escapes.
  it('never throws anything but a MigrateError', () => {
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

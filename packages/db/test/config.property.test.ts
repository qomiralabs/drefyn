import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseDatabaseConfig, parseMigrationConfig } from '../src/config.ts';
import { DbError } from '../src/errors.ts';
import { errorText } from './support.ts';

const params = { seed: 1414, numRuns: 300 };

const password = fc.string({
  unit: fc.constantFrom(
    ...Array.from(
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!$&()*+,;=._~-@:/?#[]% ',
    ),
  ),
  minLength: 12,
  maxLength: 40,
});

// Ways to break a URL that still carries the password somewhere in it.
const breakUrl = fc.constantFrom<(url: string) => string>(
  (u) => u.replace('postgres://', 'postgres//'),
  (u) => u.replace('postgres://', 'http://'),
  (u) => u.replace(/\/drefyn$/, ''),
  (u) => u.replace('127.0.0.1', '127.0 .0.1'),
  (u) => u.replace(':55432', ':0'),
  (u) => `${u}?sslmode=disable`,
  (u) => u.replace('drefyn_app', ''),
);

describe('config errors never carry secrets', () => {
  it('for a malformed URL holding any password', () => {
    fc.assert(
      fc.property(password, breakUrl, (pw, broken) => {
        const url = broken(
          `postgres://drefyn_app:${encodeURIComponent(pw)}@127.0.0.1:55432/drefyn`,
        );
        let error: unknown;
        try {
          parseDatabaseConfig({ DREFYN_DATABASE_URL: url });
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(DbError);
        const text = errorText(error);
        expect(text).not.toContain(pw);
        expect(text).not.toContain(encodeURIComponent(pw));
        expect(text).not.toContain(url);
      }),
      params,
    );
  });

  it('for a valid URL beside any bad key', () => {
    const badKey = fc.constantFrom(
      ['DREFYN_DATABASE_POOL_MAX', '0'],
      ['DREFYN_DATABASE_POOL_WAIT_MS', 'x'],
      ['DREFYN_DATABASE_STATEMENT_TIMEOUT_MS', '-1'],
      ['DREFYN_DATABASE_SSL', 'maybe'],
    );
    fc.assert(
      fc.property(password, badKey, (pw, [key, value]) => {
        const url = `postgres://drefyn_owner:${encodeURIComponent(pw)}@127.0.0.1:55432/drefyn`;
        for (const parse of [
          () => parseDatabaseConfig({ DREFYN_DATABASE_URL: url, [key]: value }),
          () => parseMigrationConfig({ DREFYN_MIGRATION_DATABASE_URL: url, [key]: value }),
        ]) {
          let error: unknown;
          try {
            parse();
          } catch (caught) {
            error = caught;
          }
          // The migration config ignores pool keys, so only SSL can fail it.
          if (error === undefined) continue;
          expect((error as DbError).code).toBe('DB_CONFIG_INVALID');
          const text = errorText(error);
          expect(text).not.toContain(pw);
          expect(text).not.toContain(encodeURIComponent(pw));
          expect(text).not.toContain(url);
        }
      }),
      params,
    );
  });
});

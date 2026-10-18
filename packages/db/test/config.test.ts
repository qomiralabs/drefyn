import { describe, expect, it } from 'vitest';
import { parseDatabaseConfig, parseMigrationConfig, type Env } from '../src/config.ts';
import { DbError } from '../src/errors.ts';
import { errorText, thrown } from './support.ts';

const PASSWORD = 'Sup3r-Secret-Pa55word';
const APP_URL = `postgres://drefyn_app:${PASSWORD}@127.0.0.1:55432/drefyn`;
const OWNER_URL = `postgres://drefyn_owner:${PASSWORD}@127.0.0.1:55432/drefyn`;

function configError(fn: () => unknown): DbError {
  const error = thrown(fn);
  expect(error).toBeInstanceOf(DbError);
  expect((error as DbError).code).toBe('DB_CONFIG_INVALID');
  return error as DbError;
}

function expectNoSecret(error: unknown, ...secrets: string[]) {
  const text = errorText(error);
  for (const secret of [PASSWORD, encodeURIComponent(PASSWORD), ...secrets]) {
    expect(text).not.toContain(secret);
  }
}

describe('parseDatabaseConfig', () => {
  it('reads the URL and applies the defaults', () => {
    expect(parseDatabaseConfig({ DREFYN_DATABASE_URL: APP_URL })).toEqual({
      url: APP_URL,
      poolMax: 10,
      poolWaitMs: 2000,
      statementTimeoutMs: 5000,
      // Safe by default; the compose stack sets disable explicitly.
      ssl: 'verify-full',
    });
  });

  it('reads every key', () => {
    expect(
      parseDatabaseConfig({
        DREFYN_DATABASE_URL: APP_URL,
        DREFYN_DATABASE_POOL_MAX: '25',
        DREFYN_DATABASE_POOL_WAIT_MS: '750',
        DREFYN_DATABASE_STATEMENT_TIMEOUT_MS: '30000',
        DREFYN_DATABASE_SSL: 'disable',
      }),
    ).toEqual({
      url: APP_URL,
      poolMax: 25,
      poolWaitMs: 750,
      statementTimeoutMs: 30000,
      ssl: 'disable',
    });
  });

  it.each(['require', 'verify-full', 'disable'] as const)(
    'accepts DREFYN_DATABASE_SSL=%s',
    (ssl) => {
      expect(
        parseDatabaseConfig({ DREFYN_DATABASE_URL: APP_URL, DREFYN_DATABASE_SSL: ssl }).ssl,
      ).toBe(ssl);
    },
  );

  it('accepts the postgresql scheme too', () => {
    const url = APP_URL.replace('postgres://', 'postgresql://');
    expect(parseDatabaseConfig({ DREFYN_DATABASE_URL: url }).url).toBe(url);
  });

  it('does not read the migration URL', () => {
    const error = configError(() =>
      parseDatabaseConfig({ DREFYN_MIGRATION_DATABASE_URL: OWNER_URL }),
    );
    expect(error.message).toContain('DREFYN_DATABASE_URL');
    expectNoSecret(error, OWNER_URL);
  });

  it.each([
    ['missing', {}],
    ['empty', { DREFYN_DATABASE_URL: '' }],
    ['blank', { DREFYN_DATABASE_URL: '   ' }],
  ])('refuses a %s URL, naming the key', (_, env: Env) => {
    expect(configError(() => parseDatabaseConfig(env)).message).toContain('DREFYN_DATABASE_URL');
  });

  it.each([
    ['not a URL', `drefyn_app:${PASSWORD}@127.0.0.1/drefyn`],
    ['another scheme', `mysql://drefyn_app:${PASSWORD}@127.0.0.1:3306/drefyn`],
    ['http', `http://drefyn_app:${PASSWORD}@127.0.0.1/drefyn`],
    ['no host', `postgres://drefyn_app:${PASSWORD}@/drefyn`],
    ['no database', `postgres://drefyn_app:${PASSWORD}@127.0.0.1:55432`],
    ['an empty database', `postgres://drefyn_app:${PASSWORD}@127.0.0.1:55432/`],
    ['a nested path', `postgres://drefyn_app:${PASSWORD}@127.0.0.1:55432/drefyn/extra`],
    ['no user', `postgres://:${PASSWORD}@127.0.0.1:55432/drefyn`],
    ['a bad port', `postgres://drefyn_app:${PASSWORD}@127.0.0.1:99999/drefyn`],
    ['a space in the host', `postgres://drefyn_app:${PASSWORD}@127.0 .0.1/drefyn`],
    ['a broken percent escape', `postgres://drefyn_app:${PASSWORD}%zz@127.0.0.1/drefyn`],
  ])('refuses a URL with %s and never echoes it', (_, url) => {
    const error = configError(() => parseDatabaseConfig({ DREFYN_DATABASE_URL: url }));
    expect(error.message).toContain('DREFYN_DATABASE_URL');
    expectNoSecret(error, url);
  });

  // DREFYN_DATABASE_SSL is the one place TLS is set; a query parameter could also set
  // session options for the role, which only migrations may decide.
  it.each([
    'sslmode=disable',
    'ssl=false',
    'sslrootcert=/tmp/x',
    'options=-c%20search_path%3Dpublic',
    'application_name=x',
  ])('refuses the URL query parameter %s, naming only its key', (query) => {
    const url = `${APP_URL}?${query}`;
    const error = configError(() => parseDatabaseConfig({ DREFYN_DATABASE_URL: url }));
    expect(error.message).toContain(query.slice(0, query.indexOf('=')));
    expectNoSecret(error, url);
  });

  it.each([
    ['DREFYN_DATABASE_POOL_MAX', '0'],
    ['DREFYN_DATABASE_POOL_MAX', '-1'],
    ['DREFYN_DATABASE_POOL_MAX', '1.5'],
    ['DREFYN_DATABASE_POOL_MAX', 'ten'],
    ['DREFYN_DATABASE_POOL_MAX', ''],
    ['DREFYN_DATABASE_POOL_MAX', ' 10'],
    ['DREFYN_DATABASE_POOL_MAX', '10 '],
    ['DREFYN_DATABASE_POOL_MAX', '1e1'],
    ['DREFYN_DATABASE_POOL_MAX', '0x10'],
    ['DREFYN_DATABASE_POOL_MAX', '+10'],
    ['DREFYN_DATABASE_POOL_MAX', '9007199254740993'],
    ['DREFYN_DATABASE_POOL_MAX', '١٠'],
    // pg reads a zero wait as wait forever.
    ['DREFYN_DATABASE_POOL_WAIT_MS', '0'],
    ['DREFYN_DATABASE_POOL_WAIT_MS', '-5'],
    ['DREFYN_DATABASE_POOL_WAIT_MS', '2s'],
    // Postgres reads a zero statement timeout as no timeout at all.
    ['DREFYN_DATABASE_STATEMENT_TIMEOUT_MS', '0'],
    ['DREFYN_DATABASE_STATEMENT_TIMEOUT_MS', '5000.0'],
    ['DREFYN_DATABASE_STATEMENT_TIMEOUT_MS', 'Infinity'],
    ['DREFYN_DATABASE_SSL', 'verify_full'],
    ['DREFYN_DATABASE_SSL', 'VERIFY-FULL'],
    ['DREFYN_DATABASE_SSL', 'prefer'],
    ['DREFYN_DATABASE_SSL', 'allow'],
    ['DREFYN_DATABASE_SSL', ''],
  ])('refuses %s=%j, naming the key and not the URL', (key, value) => {
    const error = configError(() =>
      parseDatabaseConfig({ DREFYN_DATABASE_URL: APP_URL, [key]: value }),
    );
    expect(error.message).toContain(key);
    expectNoSecret(error, APP_URL);
  });

  it('names every invalid key at once', () => {
    const error = configError(() =>
      parseDatabaseConfig({
        DREFYN_DATABASE_URL: APP_URL,
        DREFYN_DATABASE_POOL_MAX: 'many',
        DREFYN_DATABASE_SSL: 'sometimes',
      }),
    );
    expect(error.message).toContain('DREFYN_DATABASE_POOL_MAX');
    expect(error.message).toContain('DREFYN_DATABASE_SSL');
  });

  it('keeps the password out of an error caused by another key', () => {
    const error = configError(() =>
      parseDatabaseConfig({ DREFYN_DATABASE_URL: APP_URL, DREFYN_DATABASE_POOL_MAX: PASSWORD }),
    );
    expect(error.message).toContain('DREFYN_DATABASE_POOL_MAX');
    expectNoSecret(error, APP_URL);
  });
});

describe('parseMigrationConfig', () => {
  it('needs only the migration URL', () => {
    expect(parseMigrationConfig({ DREFYN_MIGRATION_DATABASE_URL: OWNER_URL })).toEqual({
      url: OWNER_URL,
      ssl: 'verify-full',
    });
  });

  it('reads DREFYN_DATABASE_SSL', () => {
    expect(
      parseMigrationConfig({
        DREFYN_MIGRATION_DATABASE_URL: OWNER_URL,
        DREFYN_DATABASE_SSL: 'disable',
      }).ssl,
    ).toBe('disable');
  });

  it('never falls back to the application URL', () => {
    const error = configError(() => parseMigrationConfig({ DREFYN_DATABASE_URL: APP_URL }));
    expect(error.message).toContain('DREFYN_MIGRATION_DATABASE_URL');
    expectNoSecret(error, APP_URL);
  });

  it('refuses a malformed migration URL without echoing it', () => {
    const url = `postgres://drefyn_owner:${PASSWORD}@127.0.0.1:55432`;
    const error = configError(() => parseMigrationConfig({ DREFYN_MIGRATION_DATABASE_URL: url }));
    expect(error.message).toContain('DREFYN_MIGRATION_DATABASE_URL');
    expectNoSecret(error, url);
  });

  it('refuses a bad SSL mode without echoing the URL', () => {
    const error = configError(() =>
      parseMigrationConfig({ DREFYN_MIGRATION_DATABASE_URL: OWNER_URL, DREFYN_DATABASE_SSL: 'on' }),
    );
    expect(error.message).toContain('DREFYN_DATABASE_SSL');
    expectNoSecret(error, OWNER_URL);
  });
});

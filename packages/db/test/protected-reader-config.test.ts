import { describe, expect, it } from 'vitest';
import { parseProtectedReaderConfig } from '../src/config.ts';
import { DbError } from '../src/errors.ts';
import { errorText, thrown } from './support.ts';

const PASSWORD = 'Sup3r-Secret-Pa55word';
const PROTECTED_URL = `postgres://drefyn_protected_reader:${PASSWORD}@127.0.0.1:55432/drefyn`;
const READER_URL = `postgres://drefyn_public_reader:${PASSWORD}@127.0.0.1:55432/drefyn`;
const APP_URL = `postgres://drefyn_app:${PASSWORD}@127.0.0.1:55432/drefyn`;
const AUTH_URL = `postgres://drefyn_auth:${PASSWORD}@127.0.0.1:55432/drefyn`;

function configError(fn: () => unknown): DbError {
  const error = thrown(fn);
  expect(error).toBeInstanceOf(DbError);
  expect((error as DbError).code).toBe('DB_CONFIG_INVALID');
  return error as DbError;
}

describe('parseProtectedReaderConfig', () => {
  it('reads the protected reader URL with a 2000 ms statement timeout', () => {
    expect(
      parseProtectedReaderConfig({ DREFYN_PROTECTED_READER_DATABASE_URL: PROTECTED_URL }),
    ).toEqual({
      url: PROTECTED_URL,
      poolMax: 10,
      poolWaitMs: 2000,
      statementTimeoutMs: 2000,
      ssl: 'verify-full',
    });
  });

  it('shares the pool and SSL keys with the other pools', () => {
    expect(
      parseProtectedReaderConfig({
        DREFYN_PROTECTED_READER_DATABASE_URL: PROTECTED_URL,
        DREFYN_DATABASE_POOL_MAX: '3',
        DREFYN_DATABASE_POOL_WAIT_MS: '500',
        DREFYN_DATABASE_SSL: 'disable',
      }),
    ).toMatchObject({ poolMax: 3, poolWaitMs: 500, ssl: 'disable' });
  });

  // Every other URL may be set on a host that serves protected pages; none may stand in.
  it('never falls back to another role when its URL is missing', () => {
    const error = configError(() =>
      parseProtectedReaderConfig({
        DREFYN_DATABASE_URL: APP_URL,
        DREFYN_PUBLIC_READER_DATABASE_URL: READER_URL,
        DREFYN_AUTH_DATABASE_URL: AUTH_URL,
      }),
    );
    expect(error.message).toContain('DREFYN_PROTECTED_READER_DATABASE_URL is missing');
    expect(errorText(error)).not.toContain(PASSWORD);
  });

  it('refuses an empty URL the same way', () => {
    const error = configError(() =>
      parseProtectedReaderConfig({ DREFYN_PROTECTED_READER_DATABASE_URL: '  ' }),
    );
    expect(error.message).toContain('DREFYN_PROTECTED_READER_DATABASE_URL is missing');
  });

  it.each([
    ['not a URL', 'nope'],
    ['a query string', `${PROTECTED_URL}?sslmode=disable`],
    ['another scheme', PROTECTED_URL.replace('postgres:', 'mysql:')],
  ])('refuses %s without echoing it', (_label, url) => {
    const error = configError(() =>
      parseProtectedReaderConfig({ DREFYN_PROTECTED_READER_DATABASE_URL: url }),
    );
    expect(error.message).toContain('DREFYN_PROTECTED_READER_DATABASE_URL');
    expect(errorText(error)).not.toContain(PASSWORD);
  });

  it('refuses a zero pool wait like the other pools', () => {
    configError(() =>
      parseProtectedReaderConfig({
        DREFYN_PROTECTED_READER_DATABASE_URL: PROTECTED_URL,
        DREFYN_DATABASE_POOL_WAIT_MS: '0',
      }),
    );
  });
});

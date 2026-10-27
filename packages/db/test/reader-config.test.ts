import { describe, expect, it } from 'vitest';
import { parsePublishedReaderConfig } from '../src/config.ts';
import { DbError } from '../src/errors.ts';
import { errorText, thrown } from './support.ts';

const PASSWORD = 'Sup3r-Secret-Pa55word';
const READER_URL = `postgres://drefyn_public_reader:${PASSWORD}@127.0.0.1:55432/drefyn`;
const APP_URL = `postgres://drefyn_app:${PASSWORD}@127.0.0.1:55432/drefyn`;

function configError(fn: () => unknown): DbError {
  const error = thrown(fn);
  expect(error).toBeInstanceOf(DbError);
  expect((error as DbError).code).toBe('DB_CONFIG_INVALID');
  return error as DbError;
}

describe('parsePublishedReaderConfig', () => {
  it('reads the reader URL with a 2000 ms statement timeout', () => {
    expect(parsePublishedReaderConfig({ DREFYN_PUBLIC_READER_DATABASE_URL: READER_URL })).toEqual({
      url: READER_URL,
      poolMax: 10,
      poolWaitMs: 2000,
      statementTimeoutMs: 2000,
      ssl: 'verify-full',
    });
  });

  it('shares the pool and SSL keys with the app pool', () => {
    expect(
      parsePublishedReaderConfig({
        DREFYN_PUBLIC_READER_DATABASE_URL: READER_URL,
        DREFYN_DATABASE_POOL_MAX: '3',
        DREFYN_DATABASE_POOL_WAIT_MS: '500',
        DREFYN_DATABASE_SSL: 'disable',
      }),
    ).toMatchObject({ poolMax: 3, poolWaitMs: 500, ssl: 'disable' });
  });

  // The public path must never end up on the app role because a key was left out.
  it('never falls back to DREFYN_DATABASE_URL', () => {
    const error = configError(() => parsePublishedReaderConfig({ DREFYN_DATABASE_URL: APP_URL }));
    expect(error.message).toContain('DREFYN_PUBLIC_READER_DATABASE_URL');
    expect(errorText(error)).not.toContain(PASSWORD);
  });

  it.each([
    ['not a URL', 'nope'],
    ['a query string', `${READER_URL}?sslmode=disable`],
    ['another scheme', READER_URL.replace('postgres:', 'mysql:')],
  ])('refuses %s without echoing it', (_label, url) => {
    const error = configError(() =>
      parsePublishedReaderConfig({ DREFYN_PUBLIC_READER_DATABASE_URL: url }),
    );
    expect(error.message).toContain('DREFYN_PUBLIC_READER_DATABASE_URL');
    expect(errorText(error)).not.toContain(PASSWORD);
  });

  it('refuses a zero pool wait like the app pool', () => {
    configError(() =>
      parsePublishedReaderConfig({
        DREFYN_PUBLIC_READER_DATABASE_URL: READER_URL,
        DREFYN_DATABASE_POOL_WAIT_MS: '0',
      }),
    );
  });
});

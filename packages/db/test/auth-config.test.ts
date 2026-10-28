import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseAuthDatabaseConfig } from '../src/config.ts';
import { DbError } from '../src/errors.ts';
import { errorText, thrown } from './support.ts';

const PASSWORD = 'Sup3r-Secret-Pa55word';
const urlAt = (host: string) => `postgres://drefyn_auth:${PASSWORD}@${host}:55432/drefyn`;
const AUTH_URL = urlAt('127.0.0.1');
const APP_URL = `postgres://drefyn_app:${PASSWORD}@127.0.0.1:55432/drefyn`;

function configError(fn: () => unknown): DbError {
  const error = thrown(fn);
  expect(error).toBeInstanceOf(DbError);
  expect((error as DbError).code).toBe('DB_CONFIG_INVALID');
  expect(errorText(error)).not.toContain(PASSWORD);
  return error as DbError;
}

describe('parseAuthDatabaseConfig', () => {
  it('reads the auth URL with a pool of 4 and verify-full by default', () => {
    expect(parseAuthDatabaseConfig({ DREFYN_AUTH_DATABASE_URL: AUTH_URL })).toEqual({
      url: AUTH_URL,
      poolMax: 4,
      poolWaitMs: 2000,
      statementTimeoutMs: 2000,
      ssl: 'verify-full',
    });
  });

  it('takes its own pool size and shares the wait and SSL keys', () => {
    expect(
      parseAuthDatabaseConfig({
        DREFYN_AUTH_DATABASE_URL: AUTH_URL,
        DREFYN_AUTH_DATABASE_POOL_MAX: '2',
        DREFYN_DATABASE_POOL_MAX: '30',
        DREFYN_DATABASE_POOL_WAIT_MS: '500',
        DREFYN_DATABASE_SSL: 'disable',
      }),
    ).toMatchObject({ poolMax: 2, poolWaitMs: 500, ssl: 'disable' });
  });

  // A missing key must not become an auth pool on the app role.
  it('never falls back to DREFYN_DATABASE_URL', () => {
    const error = configError(() => parseAuthDatabaseConfig({ DREFYN_DATABASE_URL: APP_URL }));
    expect(error.message).toContain('DREFYN_AUTH_DATABASE_URL');
  });

  it.each<[string, Record<string, string>, string]>([
    ['a zero pool', { DREFYN_AUTH_DATABASE_POOL_MAX: '0' }, 'DREFYN_AUTH_DATABASE_POOL_MAX'],
    ['a pool that is not a number', { DREFYN_AUTH_DATABASE_POOL_MAX: '4x' }, 'POOL_MAX'],
    ['an unknown SSL mode', { DREFYN_DATABASE_SSL: 'prefer' }, 'DREFYN_DATABASE_SSL'],
    ['a query string', { DREFYN_AUTH_DATABASE_URL: `${AUTH_URL}?sslmode=disable` }, 'URL'],
  ])('refuses %s, naming the key', (_label, overrides, key) => {
    const error = configError(() =>
      parseAuthDatabaseConfig({ DREFYN_AUTH_DATABASE_URL: AUTH_URL, ...overrides }),
    );
    expect(error.message).toContain(key);
  });

  it.each(['db.example.com', '10.0.0.5', 'postgres.internal', 'postgresx', 'mylocalhost'])(
    'refuses require for %s, which skips the certificate check off the machine',
    (host) => {
      const error = configError(() =>
        parseAuthDatabaseConfig({
          DREFYN_AUTH_DATABASE_URL: urlAt(host),
          DREFYN_DATABASE_SSL: 'require',
        }),
      );
      expect(error.message).toContain('DREFYN_DATABASE_SSL');
      expect(error.message).toContain('verify-full');
      expect(error.message).not.toContain(host);
    },
  );

  it('reports a broken URL once, not as a TLS problem as well', () => {
    const error = configError(() =>
      parseAuthDatabaseConfig({ DREFYN_AUTH_DATABASE_URL: 'nope', DREFYN_DATABASE_SSL: 'require' }),
    );
    expect(error.message).toContain('DREFYN_AUTH_DATABASE_URL');
    expect(error.message).not.toContain('DREFYN_DATABASE_SSL');
  });

  it.each(['db.example.com', '10.0.0.5'])('refuses disable for %s too', (host) => {
    const error = configError(() =>
      parseAuthDatabaseConfig({
        DREFYN_AUTH_DATABASE_URL: urlAt(host),
        DREFYN_DATABASE_SSL: 'disable',
      }),
    );
    expect(error.message).toContain('DREFYN_DATABASE_SSL');
  });

  it.each(['127.0.0.1', '127.8.9.10', 'localhost', '[::1]', 'postgres'])(
    'accepts require and disable for %s, on this machine or the compose network',
    (host) => {
      for (const ssl of ['require', 'disable'] as const) {
        expect(
          parseAuthDatabaseConfig({
            DREFYN_AUTH_DATABASE_URL: urlAt(host),
            DREFYN_DATABASE_SSL: ssl,
          }).ssl,
        ).toBe(ssl);
      }
    },
  );

  it.each(['db.example.com', '10.0.0.5', '127.0.0.1', 'postgres'])(
    'accepts verify-full for %s',
    (host) => {
      expect(
        parseAuthDatabaseConfig({
          DREFYN_AUTH_DATABASE_URL: urlAt(host),
          DREFYN_DATABASE_SSL: 'verify-full',
        }).ssl,
      ).toBe('verify-full');
    },
  );
});

const LOCAL = new Set(['localhost', 'postgres', '[::1]']);
const isLoopbackV4 = (host: string) => /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);

describe('auth pool TLS for any host', () => {
  const label = fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,10}[a-z0-9])?$/);
  const host = fc.oneof(
    fc.array(label, { minLength: 1, maxLength: 4 }).map((parts) => parts.join('.')),
    fc.ipV4(),
    fc.constantFrom('postgres', 'localhost', 'postgres-1', 'localhost.example.com', '128.0.0.1'),
  );

  it('accepts require only for loopback or the compose service name', () => {
    fc.assert(
      fc.property(host, (name) => {
        const url = urlAt(name);
        // The URL parser decides what the host is, the same way the check does.
        const parsed = new URL(url).hostname;
        const local = LOCAL.has(parsed) || isLoopbackV4(parsed);
        let error: unknown;
        try {
          parseAuthDatabaseConfig({
            DREFYN_AUTH_DATABASE_URL: url,
            DREFYN_DATABASE_SSL: 'require',
          });
        } catch (caught) {
          error = caught;
        }
        if (local) expect(error).toBeUndefined();
        else {
          expect(error).toBeInstanceOf(DbError);
          expect(errorText(error)).not.toContain(PASSWORD);
        }
      }),
      { seed: 1270, numRuns: 400 },
    );
  });
});

import { organizationId, projectId } from '@drefyn/tenancy';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  parseAuthDatabaseConfig,
  parseDatabaseConfig,
  parsePublishedReaderConfig,
} from '../src/config.ts';
import {
  closeDatabase,
  createAuthDatabase,
  createDatabase,
  createPublishedDatabase,
  databaseOverPool,
  poolConfig,
  withApiKeyLimiter,
  withAuth,
  withPublishedReader,
  withTenant,
  type AuthDatabase,
  type Database,
  type PublishedDatabase,
} from '../src/database.ts';
import { DbError } from '../src/errors.ts';
import { reserveApiKeyFailureWindows, reserveAuthRateWindows } from '../src/rate-windows.ts';
import { rejected } from './support.ts';

const URL = 'postgres://drefyn_app:Sup3r-Secret-Pa55word@127.0.0.1:1/drefyn';
const ORG = organizationId('01a14984-4476-77ce-9335-2c3c3a59aa8b');
const PROJECT = projectId('01a14984-4476-77ce-9335-2c3c3a59aa8c');

async function code(promise: Promise<unknown>): Promise<string> {
  const error = await rejected(promise);
  return error instanceof DbError ? error.code : `not a DbError: ${String(error)}`;
}

describe('createDatabase before connecting', () => {
  // A configured default above the per call ceiling would turn the cap into a suggestion.
  it('refuses an app statement timeout above 60 s', async () => {
    const config = parseDatabaseConfig({
      DREFYN_DATABASE_URL: URL,
      DREFYN_DATABASE_STATEMENT_TIMEOUT_MS: '60001',
    });
    expect(await code(createDatabase(config))).toBe('DB_CONFIG_INVALID');
  });

  it('refuses a reader statement timeout above 10 s', async () => {
    const config = {
      ...parsePublishedReaderConfig({ DREFYN_PUBLIC_READER_DATABASE_URL: URL }),
      statementTimeoutMs: 10_001,
    };
    expect(await code(createPublishedDatabase(config))).toBe('DB_CONFIG_INVALID');
  });

  it('refuses an auth statement timeout above 10 s', async () => {
    const config = {
      ...parseAuthDatabaseConfig({ DREFYN_AUTH_DATABASE_URL: URL }),
      statementTimeoutMs: 10_001,
    };
    expect(await code(createAuthDatabase(config))).toBe('DB_CONFIG_INVALID');
  });

  it('fails an unreachable auth database with DB_UNAVAILABLE', async () => {
    const config = parseAuthDatabaseConfig({
      DREFYN_AUTH_DATABASE_URL: URL,
      DREFYN_DATABASE_POOL_WAIT_MS: '200',
    });
    const error = await rejected(createAuthDatabase(config));
    expect((error as DbError).code).toBe('DB_UNAVAILABLE');
  });
});

describe('handles that did not come from the constructors', () => {
  it.each<[string, unknown]>([
    ['a plain object', {}],
    ['null', null],
    ['a string', 'postgres://x'],
  ])('refuse %s with DB_CONFIG_INVALID before any work', async (_label, db) => {
    let ran = false;
    const work = () => {
      ran = true;
      return Promise.resolve(1);
    };
    expect(
      await code(withTenant(db as Database, { organizationId: ORG, projectId: PROJECT }, work)),
    ).toBe('DB_CONFIG_INVALID');
    expect(ran).toBe(false);
  });

  it('refuse a reader handle that was never opened', async () => {
    const fake = Object.freeze({}) as PublishedDatabase;
    const tenant = { organizationId: ORG, projectId: PROJECT };
    expect(await code(withPublishedReader(fake, tenant, () => Promise.resolve(1)))).toBe(
      'DB_CONFIG_INVALID',
    );
  });

  it('refuse an auth handle that was never opened', async () => {
    const fake = Object.freeze({}) as AuthDatabase;
    expect(await code(withAuth(fake, () => Promise.resolve(1)))).toBe('DB_CONFIG_INVALID');
  });

  it('close as a no op', async () => {
    await expect(closeDatabase({} as Database)).resolves.toBeUndefined();
  });
});

describe('poolConfig', () => {
  const config = (url: string) => parseDatabaseConfig({ DREFYN_DATABASE_URL: url });

  it('takes every connection field from the URL and none from the environment', async () => {
    const pool = poolConfig(config('postgres://drefyn_app:p%40ss@db.internal/drefyn'), 'app');
    expect(pool).toMatchObject({
      host: 'db.internal',
      port: 5432,
      user: 'drefyn_app',
      database: 'drefyn',
      application_name: 'drefyn-app',
      max: 10,
      connectionTimeoutMillis: 2000,
      ssl: { rejectUnauthorized: true },
    });
    const password = pool.password;
    expect(typeof password).toBe('function');
    if (typeof password === 'function') expect(await password()).toBe('p@ss');
  });

  it('unwraps an IPv6 host and names the reader pool', () => {
    const pool = poolConfig(
      config('postgres://drefyn_public_reader:x@[::1]:55432/drefyn'),
      'reader',
    );
    expect(pool).toMatchObject({
      host: '::1',
      port: 55432,
      application_name: 'drefyn-public-reader',
    });
  });

  // The server's own timeout has to answer first on a healthy connection, as that one rolls back
  // cleanly, so each limit sits past the longest timeout that pool allows.
  it.each([
    ['app', 65_000],
    ['reader', 15_000],
    ['auth', 15_000],
  ] as const)('gives up on a %s query at %i ms', (kind, limit) => {
    const pool = poolConfig(config('postgres://u:x@127.0.0.1/drefyn'), kind);
    expect(pool.query_timeout).toBe(limit);
  });

  it('names the auth pool', () => {
    expect(poolConfig(config('postgres://drefyn_auth:x@127.0.0.1/drefyn'), 'auth')).toMatchObject({
      application_name: 'drefyn-auth',
    });
  });
});

// Answers a transaction statement by statement and a reservation in its one message, and
// counts the connections taken: a nested reservation must not take one.
function counting(kind: 'auth' | 'app') {
  let connections = 0;
  const ok = (rows: unknown[] = []) => ({ command: 'SELECT', rows, rowCount: rows.length });
  const client = {
    on: () => client,
    removeListener: () => client,
    release: () => undefined,
    query: (text: string) =>
      Promise.resolve(
        text.includes('window_seconds')
          ? [ok(), ok(), ok(), ok([{ window_seconds: 60, count: 1, retry_after: 9 }]), ok()]
          : ok(),
      ),
  };
  const pool = {
    connect: () => {
      connections += 1;
      return Promise.resolve(client);
    },
  };
  const db = databaseOverPool(pool as unknown as pg.Pool, kind, { statementTimeoutMs: 5000 });
  return { db, connections: () => connections };
}

const KEY = new Uint8Array(32).fill(0x5a);
const request = { bucket: 'email_send', keyHmac: KEY, windowSeconds: [60] };

type Hold = (work: () => Promise<unknown>) => Promise<unknown>;
type Reserve = () => Promise<unknown>;

describe('a reservation inside a limiter or sign in transaction', () => {
  const auth = counting('auth');
  const app = counting('app');
  const taken = () => auth.connections() + app.connections();
  const holders: readonly (readonly [string, Hold])[] = [
    ['withAuth', (work) => withAuth(auth.db as AuthDatabase, work)],
    ['withApiKeyLimiter', (work) => withApiKeyLimiter(app.db as Database, work)],
  ];
  const reservers: readonly (readonly [string, Reserve])[] = [
    ['reserveAuthRateWindows', () => reserveAuthRateWindows(auth.db as AuthDatabase, request)],
    [
      'reserveApiKeyFailureWindows',
      () => reserveApiKeyFailureWindows(app.db as Database, { keyHmac: KEY, windowSeconds: [60] }),
    ],
  ];
  const pairs = holders.flatMap(([holder, hold]) =>
    reservers.map(([reserver, reserve]) => [holder, reserver, hold, reserve] as const),
  );

  it.each(pairs)('%s refuses %s before it takes a connection', async (_h, _r, hold, reserve) => {
    const refused = await hold(async () => {
      const before = taken();
      const error = await rejected(reserve());
      expect(taken()).toBe(before);
      return error;
    });
    expect(refused).toBeInstanceOf(DbError);
    expect(refused).toMatchObject({ code: 'DB_RESERVATION_NESTED' });
  });

  it.each(pairs)('%s still refuses %s after a hop', async (_h, _r, hold, reserve) => {
    const refused = await hold(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return rejected(reserve());
    });
    expect(refused).toMatchObject({ code: 'DB_RESERVATION_NESTED' });
  });

  it.each(pairs)('%s leaves %s free once it has ended', async (_h, _r, hold, reserve) => {
    await hold(() => Promise.resolve());
    await expect(reserve()).resolves.toHaveLength(1);
  });

  // Fire and forget work keeps the async context, but its transaction is gone, so it holds
  // nothing and a refusal here would be a false lock out.
  it.each(pairs)('%s lets go of work it left behind', async (_h, _r, hold, reserve) => {
    const gate = Promise.withResolvers<undefined>();
    let left: Promise<unknown> = Promise.resolve();
    await hold(() => {
      left = gate.promise.then(reserve);
      return Promise.resolve();
    });
    gate.resolve(undefined);
    await expect(left).resolves.toHaveLength(1);
  });

  it.each(pairs)('%s does not reach %s in another request', async (_h, _r, hold, reserve) => {
    const gate = Promise.withResolvers<undefined>();
    const held = hold(() => gate.promise);
    await expect(reserve()).resolves.toHaveLength(1);
    gate.resolve(undefined);
    await held;
  });

  it('lets go when the work fails', async () => {
    const failed = await rejected(
      withAuth(auth.db as AuthDatabase, () => Promise.reject(new Error('work failed'))),
    );
    expect(String(failed)).toContain('work failed');
    await expect(reserveAuthRateWindows(auth.db as AuthDatabase, request)).resolves.toHaveLength(1);
  });
});

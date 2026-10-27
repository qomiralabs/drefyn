import { organizationId, projectId } from '@drefyn/tenancy';
import { describe, expect, it } from 'vitest';
import { parseDatabaseConfig, parsePublishedReaderConfig } from '../src/config.ts';
import {
  closeDatabase,
  createDatabase,
  createPublishedDatabase,
  poolConfig,
  withPublishedReader,
  withTenant,
  type Database,
  type PublishedDatabase,
} from '../src/database.ts';
import { DbError } from '../src/errors.ts';
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
});

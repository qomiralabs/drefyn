import { describe, expect, it } from 'vitest';
import { parseDatabaseConfig, parsePublishedReaderConfig } from '../src/config.ts';
import { createDatabase, createPublishedDatabase } from '../src/database.ts';
import { DbError } from '../src/errors.ts';
import { errorText, rejected } from './support.ts';

const PASSWORD = 'Sup3r-Secret-Pa55word';

// Port 1 on loopback refuses at once, so these need no stack and wait for nothing.
const closedPort = (role: string) => `postgres://${role}:${PASSWORD}@127.0.0.1:1/drefyn`;

describe('createDatabase without a server', () => {
  it('fails with DB_UNAVAILABLE and no secret', async () => {
    const config = parseDatabaseConfig({
      DREFYN_DATABASE_URL: closedPort('drefyn_app'),
      DREFYN_DATABASE_SSL: 'disable',
      DREFYN_DATABASE_POOL_WAIT_MS: '500',
    });
    const error = await rejected(createDatabase(config));
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe('DB_UNAVAILABLE');
    expect(errorText(error)).not.toContain(PASSWORD);
  });

  it('fails the reader pool the same way', async () => {
    const config = parsePublishedReaderConfig({
      DREFYN_PUBLIC_READER_DATABASE_URL: closedPort('drefyn_public_reader'),
      DREFYN_DATABASE_SSL: 'disable',
      DREFYN_DATABASE_POOL_WAIT_MS: '500',
    });
    const error = await rejected(createPublishedDatabase(config));
    expect((error as DbError).code).toBe('DB_UNAVAILABLE');
    expect(errorText(error)).not.toContain(PASSWORD);
  });
});

import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import { sql } from 'kysely';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDatabaseConfig } from '../src/config.ts';
import { databaseOverPool, poolConfig, withTenant, type Database } from '../src/database.ts';
import { DbError } from '../src/errors.ts';
import { rejected } from './support.ts';

const TENANT: TenantRef = {
  organizationId: organizationId('01a14984-4476-77ce-9335-2c3c3a59aa8b'),
  projectId: projectId('01a14984-4476-77ce-9335-2c3c3a59aa8c'),
};
const LIMIT_MS = 100;
const HANGS = 'select hangs_here';

const message = (type: string, body: Buffer = Buffer.alloc(0)): Buffer => {
  const length = Buffer.alloc(4);
  length.writeInt32BE(body.length + 4);
  return Buffer.concat([Buffer.from(type), length, body]);
};
const READY = message('Z', Buffer.from('I'));
const DONE = message('C', Buffer.from('SELECT 0\0'));
const AUTH_OK = message('R', Buffer.alloc(4));
const SIMPLE_ANSWER = Buffer.concat([DONE, READY]);
const EXTENDED_ANSWER = Buffer.concat([message('1'), message('2'), message('n'), DONE, READY]);

// Speaks just enough of the protocol to run a transaction. The statement marked to hang gets no
// answer, and neither does anything after it, and the socket stays open: what a peer that
// vanished without a FIN looks like from here.
function answer(socket: Socket): void {
  let started = false;
  let dead = false;
  let pending = Buffer.alloc(0);
  socket.on('error', () => undefined);
  socket.on('data', (data) => {
    pending = Buffer.concat([pending, data]);
    if (!started) {
      if (pending.length < 4 || pending.length < pending.readInt32BE(0)) return;
      pending = pending.subarray(pending.readInt32BE(0));
      started = true;
      socket.write(Buffer.concat([AUTH_OK, READY]));
    }
    while (pending.length >= 5 && pending.length >= pending.readInt32BE(1) + 1) {
      const size = pending.readInt32BE(1) + 1;
      const frame = pending.subarray(0, size);
      pending = pending.subarray(size);
      if (frame.includes(HANGS)) dead = true;
      if (dead) continue;
      const type = String.fromCharCode(frame.readUInt8(0));
      if (type === 'Q') socket.write(SIMPLE_ANSWER);
      if (type === 'S') socket.write(EXTENDED_ANSWER);
    }
  });
}

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function listening(): Promise<number> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    answer(socket);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          resolve();
        });
      }),
  );
  return (server.address() as AddressInfo).port;
}

// The real pool settings with one slot and a short limit, so a held slot is plain to see.
async function oneSlot(): Promise<{ readonly pool: pg.Pool; readonly db: Database }> {
  const port = await listening();
  const config = parseDatabaseConfig({
    DREFYN_DATABASE_URL: `postgres://drefyn_app:x@127.0.0.1:${String(port)}/drefyn`,
    DREFYN_DATABASE_SSL: 'disable',
    DREFYN_DATABASE_POOL_MAX: '1',
    DREFYN_DATABASE_POOL_WAIT_MS: '5000',
  });
  const pool = new pg.Pool({ ...poolConfig(config, 'app'), query_timeout: LIMIT_MS });
  pool.on('error', () => undefined);
  closers.push(() => pool.end());
  const db = databaseOverPool(pool, 'app', { statementTimeoutMs: 1000 }) as Database;
  return { pool, db };
}

describe('a connection that stops answering', () => {
  it('fails the work with a mapped error and gives up the slot within two limits', async () => {
    const { pool, db } = await oneSlot();
    const started = performance.now();
    const failed = await rejected(withTenant(db, TENANT, (tx) => sql.raw(HANGS).execute(tx)));
    const elapsed = performance.now() - started;

    expect(failed).toBeInstanceOf(DbError);
    expect((failed as DbError).code).toBe('DB_UNAVAILABLE');
    // The statement, then the rollback queued behind it. Slower than that means a third wait.
    expect(elapsed).toBeGreaterThanOrEqual(2 * LIMIT_MS - 5);
    expect(elapsed).toBeLessThan(3 * LIMIT_MS);
    expect(pool.totalCount).toBe(0);
  });

  it('never returns the connection to the next tenant, who gets a fresh one', async () => {
    const { pool, db } = await oneSlot();
    const stuck = rejected(withTenant(db, TENANT, (tx) => sql.raw(HANGS).execute(tx)));
    const next = withTenant(db, TENANT, (tx) => sql.raw('select 1').execute(tx));

    expect((await next).rows).toEqual([]);
    expect(await stuck).toBeInstanceOf(DbError);
    expect(pool.waitingCount).toBe(0);
  });
});

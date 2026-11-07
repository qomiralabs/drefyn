import { Duplex } from 'node:stream';
import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import { sql } from 'kysely';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDatabaseConfig } from '../src/config.ts';
import { databaseOverPool, poolConfig, withTenant, type Database } from '../src/database.ts';
import { rejected } from './support.ts';

const TENANT: TenantRef = {
  organizationId: organizationId('01a14984-4476-77ce-9335-2c3c3a59aa8b'),
  projectId: projectId('01a14984-4476-77ce-9335-2c3c3a59aa8c'),
};
const DEADLINE_MS = 100;
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

// Speaks just enough of the protocol for the real pool and driver to run a transaction, in memory.
// The marked statement gets no answer, nor does anything after it, and the stream stays open:
// a peer gone with no FIN, which no timeout in Postgres can reach.
class SilentPeer extends Duplex {
  #started = false;
  #dead = false;
  #pending = Buffer.alloc(0);

  connect(): this {
    setImmediate(() => this.emit('connect'));
    return this;
  }

  setNoDelay(): this {
    return this;
  }

  setKeepAlive(): this {
    return this;
  }

  override _read(): void {
    // Answers are pushed as frames arrive.
  }

  override _write(chunk: Buffer, _encoding: string, done: () => void): void {
    this.#pending = Buffer.concat([this.#pending, chunk]);
    this.#answer();
    done();
  }

  #answer(): void {
    if (!this.#started) {
      const size = this.#pending.length < 4 ? Infinity : this.#pending.readInt32BE(0);
      if (this.#pending.length < size) return;
      this.#pending = this.#pending.subarray(size);
      this.#started = true;
      this.push(Buffer.concat([AUTH_OK, READY]));
    }
    while (this.#pending.length >= 5) {
      const size = this.#pending.readInt32BE(1) + 1;
      if (this.#pending.length < size) return;
      const frame = this.#pending.subarray(0, size);
      this.#pending = this.#pending.subarray(size);
      if (frame.includes(HANGS)) this.#dead = true;
      if (this.#dead) continue;
      const type = String.fromCharCode(frame.readUInt8(0));
      if (type === 'Q') this.push(SIMPLE_ANSWER);
      if (type === 'S') this.push(EXTENDED_ANSWER);
    }
  }
}

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

function oneConnection(): { readonly pool: pg.Pool; readonly db: Database } {
  const config = parseDatabaseConfig({
    DREFYN_DATABASE_URL: 'postgres://drefyn_app:x@127.0.0.1:1/drefyn',
    DREFYN_DATABASE_SSL: 'disable',
    DREFYN_DATABASE_POOL_MAX: '1',
    DREFYN_DATABASE_POOL_WAIT_MS: '5000',
  });
  const pool = new pg.Pool({ ...poolConfig(config, 'app'), stream: () => new SilentPeer() });
  pool.on('error', () => undefined);
  closers.push(() => pool.end());
  const db = databaseOverPool(pool, 'app', { statementTimeoutMs: 1000 }) as Database;
  return { pool, db };
}

const hanging = (db: Database) =>
  withTenant(db, TENANT, (tx) => sql.raw(HANGS).execute(tx), { deadlineMs: DEADLINE_MS });

describe('a deadline on a connection that stops answering', () => {
  it('fails the work and gives the connection up, on the real driver', async () => {
    const { pool, db } = oneConnection();
    const started = performance.now();
    expect(await rejected(hanging(db))).toMatchObject({ code: 'DB_TIMEOUT' });
    expect((performance.now() - started) / DEADLINE_MS).toBeGreaterThanOrEqual(0.9);
    expect(pool.totalCount).toBe(0);
  });

  it('leaves the pool able to open the next one, so a dead socket costs no capacity', async () => {
    const { db } = oneConnection();
    await rejected(hanging(db));
    await expect(
      withTenant(db, TENANT, () => Promise.resolve('next'), { deadlineMs: DEADLINE_MS }),
    ).resolves.toBe('next');
  });

  it('reports the deadline, however much work was left', async () => {
    const { db } = oneConnection();
    const failure = await rejected(
      withTenant(
        db,
        TENANT,
        async (tx) => {
          await sql.raw(HANGS).execute(tx);
          await sql`select after_it`.execute(tx);
        },
        { deadlineMs: DEADLINE_MS },
      ),
    );
    expect(failure).toMatchObject({ code: 'DB_TIMEOUT' });
  });
});

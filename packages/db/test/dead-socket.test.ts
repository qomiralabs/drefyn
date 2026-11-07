import { Duplex } from 'node:stream';
import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import { sql, type Transaction } from 'kysely';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDatabaseConfig } from '../src/config.ts';
import { databaseOverPool, poolConfig, withTenant, type Database } from '../src/database.ts';
import { DbError } from '../src/errors.ts';
import type { TenantSchema } from '../src/organization.ts';
import { rejected } from './support.ts';

const TENANT: TenantRef = {
  organizationId: organizationId('01a14984-4476-77ce-9335-2c3c3a59aa8b'),
  projectId: projectId('01a14984-4476-77ce-9335-2c3c3a59aa8c'),
};
const LIMIT_MS = 100;
const HANGS = 'select hangs_here';
const LATE = 'select answers_late';

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

interface PeerScript {
  // The first statement holding this text gets no answer, nor does anything after it.
  readonly silentOn?: string;
  // The first statement holding this text waits, with what follows it, until answerLate.
  readonly lateOn?: string;
}

// Speaks just enough of the protocol to run a transaction, in memory, so the real pool and driver
// run with no port. The stream stays open whatever the client does, end included: what a peer that
// vanished without a FIN looks like from here.
class SilentPeer extends Duplex {
  readonly #script: Required<PeerScript>;
  #started = false;
  #dead = false;
  #late = false;
  #held: Buffer[] = [];
  #pending = Buffer.alloc(0);

  constructor(script: PeerScript) {
    super();
    this.#script = { silentOn: HANGS, lateOn: LATE, ...script };
  }

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
    // Never in the same tick, as with a socket: a query queued behind another is written from
    // inside the driver's parser, which cannot take a second message while it reads the first.
    setImmediate(() => {
      this.#answer();
    });
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
      if (frame.includes(this.#script.lateOn)) this.#late = true;
      if (this.#late) this.#held.push(frame);
      else this.#reply(frame);
    }
  }

  #reply(frame: Buffer): void {
    if (frame.includes(this.#script.silentOn)) this.#dead = true;
    if (this.#dead) return;
    const type = String.fromCharCode(frame.readUInt8(0));
    if (type === 'Q') this.push(SIMPLE_ANSWER);
    if (type === 'S') this.push(EXTENDED_ANSWER);
  }

  answerLate(): void {
    this.#late = false;
    for (const frame of this.#held.splice(0)) this.#reply(frame);
  }
}

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

interface SlotOptions extends PeerScript {
  readonly poolWaitMs?: number;
  // Answers the late statement the moment the client asks for this one, so the answer lands
  // inside the new statement's limit however loaded the machine is.
  readonly answerLateOn?: string;
}

// The real pool settings with one slot and a short limit, so a held slot is plain to see.
function oneSlot(options: SlotOptions = {}): {
  readonly pool: pg.Pool;
  readonly db: Database;
  readonly sent: readonly string[];
  readonly answerLate: () => void;
} {
  const { poolWaitMs = 5000, answerLateOn, ...script } = options;
  const config = parseDatabaseConfig({
    DREFYN_DATABASE_URL: 'postgres://drefyn_app:x@127.0.0.1:1/drefyn',
    DREFYN_DATABASE_SSL: 'disable',
    DREFYN_DATABASE_POOL_MAX: '1',
    DREFYN_DATABASE_POOL_WAIT_MS: String(poolWaitMs),
  });
  const peers: SilentPeer[] = [];
  const answerLate = () => {
    for (const peer of peers) peer.answerLate();
  };
  const pool = new pg.Pool({
    ...poolConfig(config, 'app'),
    query_timeout: LIMIT_MS,
    stream: () => {
      const peer = new SilentPeer(script);
      peers.push(peer);
      return peer;
    },
  });
  pool.on('error', () => undefined);
  closers.push(() => pool.end());
  // What the client asked for, as a queued statement never reaches the silent server.
  const sent: string[] = [];
  pool.on('connect', (client) => {
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    Object.assign(client, {
      query: (...args: unknown[]) => {
        sent.push(String(args[0]));
        const answer = query(...args);
        if (args[0] === answerLateOn) answerLate();
        return answer;
      },
    });
  });
  const db = databaseOverPool(pool, 'app', { statementTimeoutMs: 1000 }) as Database;
  return { pool, db, sent, answerLate };
}

describe('a connection that stops answering', () => {
  it('fails the work with a mapped error and gives up the slot', async () => {
    const { pool, db, sent } = oneSlot();
    const started = performance.now();
    const failed = await rejected(withTenant(db, TENANT, (tx) => sql.raw(HANGS).execute(tx)));
    const elapsed = performance.now() - started;

    expect(failed).toBeInstanceOf(DbError);
    expect((failed as DbError).code).toBe('DB_UNAVAILABLE');
    expect(pool.totalCount).toBe(0);
    // Each statement gets one limit, so this pair is what makes the bound two limits. The clock
    // only shows that both were waited for: its upper end would be a flake under load.
    expect(sent.slice(sent.indexOf(HANGS) + 1)).toEqual(['rollback']);
    expect(elapsed).toBeGreaterThanOrEqual(2 * LIMIT_MS - 5);
  });

  it('never returns the connection to the next tenant, who gets a fresh one', async () => {
    const { pool, db } = oneSlot();
    const stuck = rejected(withTenant(db, TENANT, (tx) => sql.raw(HANGS).execute(tx)));
    const next = withTenant(db, TENANT, (tx) => sql.raw('select 1').execute(tx));

    expect((await next).rows).toEqual([]);
    expect(await stuck).toBeInstanceOf(DbError);
    expect(pool.waitingCount).toBe(0);
  });
});

describe('a statement that passes the client limit and then gets its answer', () => {
  const swallowing = (tx: Transaction<TenantSchema>) =>
    sql
      .raw(LATE)
      .execute(tx)
      .then(
        () => undefined,
        () => 'swallowed',
      );
  const committed = (sent: readonly string[]) => sent.some((text) => text.endsWith('commit'));

  it('never commits work that swallowed the timeout, and rolls it back', async () => {
    const { pool, db, sent, answerLate } = oneSlot();
    const failed = await rejected(
      withTenant(db, TENANT, async (tx) => {
        const outcome = await swallowing(tx);
        answerLate();
        return outcome;
      }),
    );

    expect(failed).toMatchObject({ code: 'DB_UNAVAILABLE' });
    expect(committed(sent)).toBe(false);
    expect(sent.slice(sent.indexOf(LATE) + 1)).toEqual(['rollback', 'discard all']);
    // The rollback was answered, so the connection is clean and stays.
    expect(pool.totalCount).toBe(1);
  });

  it('refuses later statements too, so each one cannot buy another limit', async () => {
    const { db, sent, answerLate } = oneSlot();
    const failed = await rejected(
      withTenant(db, TENANT, async (tx) => {
        await swallowing(tx);
        answerLate();
        await sql`select after_it`.execute(tx);
      }),
    );

    expect(failed).toMatchObject({ code: 'DB_UNAVAILABLE' });
    expect(sent).not.toContain('select after_it');
  });

  it('gives discard all its own limit, which is what makes the bound three limits', async () => {
    const { pool, db, sent } = oneSlot({ silentOn: 'discard all', answerLateOn: 'rollback' });
    const started = performance.now();
    const failed = await rejected(withTenant(db, TENANT, (tx) => sql.raw(LATE).execute(tx)));
    const elapsed = performance.now() - started;

    expect(failed).toMatchObject({ code: 'DB_UNAVAILABLE' });
    expect(sent.slice(sent.indexOf(LATE) + 1)).toEqual(['rollback', 'discard all']);
    expect(pool.totalCount).toBe(0);
    // The rollback was answered at once here, so this is its statement's limit and discard's.
    // A peer that answers just inside the rollback's limit spends a third in between.
    expect(elapsed).toBeGreaterThanOrEqual(2 * LIMIT_MS - 5);
  });
});

describe('a deadline on a connection that stops answering', () => {
  const DEADLINE_MS = 30;
  const hanging = (db: Database) =>
    withTenant(db, TENANT, (tx) => sql.raw(HANGS).execute(tx), { deadlineMs: DEADLINE_MS });

  it('fails the work and gives the connection up, ahead of the client limit', async () => {
    const { pool, db, sent } = oneSlot();
    const started = performance.now();
    const failed = await rejected(hanging(db));
    const elapsed = performance.now() - started;

    expect(failed).toMatchObject({ code: 'DB_UNAVAILABLE' });
    expect((failed as DbError).message).toContain('deadline');
    expect(pool.totalCount).toBe(0);
    expect(sent).not.toContain('discard all');
    expect(elapsed / DEADLINE_MS).toBeGreaterThanOrEqual(0.9);
  });

  it('leaves the pool able to open the next one, so a dead socket costs no capacity', async () => {
    const { db } = oneSlot();
    await rejected(hanging(db));
    await expect(
      withTenant(db, TENANT, () => Promise.resolve('next'), { deadlineMs: DEADLINE_MS }),
    ).resolves.toBe('next');
  });

  it('reports the deadline, however much work was left', async () => {
    const { db } = oneSlot();
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
    expect((failure as DbError).message).toContain('deadline');
  });

  it('fails during commit, where the outcome is unknown, and drops the connection', async () => {
    const { pool, db, sent } = oneSlot({ silentOn: 'commit' });
    const failed = await rejected(
      withTenant(db, TENANT, () => Promise.resolve('done'), { deadlineMs: DEADLINE_MS }),
    );

    expect(failed).toMatchObject({ code: 'DB_UNAVAILABLE' });
    expect((failed as DbError).message).toContain('deadline');
    expect(sent.at(-2)).toContain('commit');
    expect(sent.at(-1)).toBe('rollback');
    expect(pool.totalCount).toBe(0);
  });

  it('still reports success during discard all, as the commit landed', async () => {
    const { pool, db, sent } = oneSlot({ silentOn: 'discard all' });
    await expect(
      withTenant(db, TENANT, () => Promise.resolve('done'), { deadlineMs: DEADLINE_MS }),
    ).resolves.toBe('done');

    expect(sent.at(-1)).toBe('discard all');
    expect(pool.totalCount).toBe(0);
    await expect(withTenant(db, TENANT, () => Promise.resolve('next'))).resolves.toBe('next');
  });

  // The wait is far longer than the deadline and far shorter than the test's own timeout, so a
  // waiter that only wakes when the wait runs out fails instead of passing slowly.
  it('wakes a pool waiter when it fires between statements on a peer ignoring close', async () => {
    const { pool, db } = oneSlot({ poolWaitMs: 1000 });
    let finish = (): void => undefined;
    const idle = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const cut = rejected(withTenant(db, TENANT, () => idle, { deadlineMs: DEADLINE_MS }));
    const next = withTenant(db, TENANT, () => Promise.resolve('next'));

    // The work is still out: the slot must not depend on it coming back.
    const [served] = await Promise.allSettled([next]);
    const waiting = pool.waitingCount;
    finish();
    const failed = await cut;

    expect(served).toEqual({ status: 'fulfilled', value: 'next' });
    expect(waiting).toBe(0);
    expect(failed).toMatchObject({ code: 'DB_UNAVAILABLE' });
    expect((failed as DbError).message).toContain('deadline');
  });

  it('wakes a waiter on the same peer once a work that outlasts the deadline returns', async () => {
    const { db, sent } = oneSlot({ poolWaitMs: 1000 });
    const cut = rejected(
      withTenant(
        db,
        TENANT,
        async (tx) => {
          await new Promise((resolve) => setTimeout(resolve, 3 * DEADLINE_MS));
          await sql`select too_late`.execute(tx);
        },
        { deadlineMs: DEADLINE_MS },
      ),
    );
    const next = withTenant(db, TENANT, () => Promise.resolve('next'));

    await expect(next).resolves.toBe('next');
    expect((await cut) as DbError).toMatchObject({ code: 'DB_UNAVAILABLE' });
    expect(sent.filter((text) => text.endsWith('commit'))).toHaveLength(1);
  });

  it('reports the deadline for a work that swallowed the failure', async () => {
    const { db, sent } = oneSlot();
    const failed = await rejected(
      withTenant(
        db,
        TENANT,
        (tx) =>
          sql
            .raw(HANGS)
            .execute(tx)
            .catch(() => 'swallowed'),
        { deadlineMs: DEADLINE_MS },
      ),
    );

    expect((failed as DbError).message).toContain('deadline');
    expect(sent.some((text) => text.endsWith('commit'))).toBe(false);
  });
});

import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  closeDatabase,
  databaseOverPool,
  pingDatabase,
  type Database,
  type PublishedDatabase,
} from '../src/database.ts';
import { DbError } from '../src/errors.ts';
import { rejected } from './support.ts';

type Answer = (text: string) => Promise<unknown>;

class PingClient extends EventEmitter {
  readonly sent: string[] = [];
  released: unknown = 'not released';
  destroyed = false;
  readonly connection = {
    stream: {
      destroy: () => {
        this.destroyed = true;
      },
    },
  };
  private readonly answer: Answer;

  constructor(answer: Answer) {
    super();
    this.answer = answer;
  }

  query(text: string): Promise<unknown> {
    this.sent.push(text);
    return this.answer(text);
  }

  release(error?: unknown): void {
    this.released = error;
  }
}

function pool(kind: 'app' | 'reader' | 'auth', answer: Answer, connectFails = false) {
  const clients: PingClient[] = [];
  const fake = {
    connect: () => {
      if (connectFails) return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:1'));
      const client = new PingClient(answer);
      clients.push(client);
      return Promise.resolve(client);
    },
    end: () => Promise.resolve(),
  };
  const db = databaseOverPool(fake as unknown as pg.Pool, kind, { statementTimeoutMs: 2000 });
  return { db, clients };
}

const answered = () => Promise.resolve({ command: 'SELECT', rows: [{ '?column?': 1 }] });

async function code(promise: Promise<unknown>): Promise<string> {
  const error = await rejected(promise);
  return error instanceof DbError ? error.code : `not a DbError: ${String(error)}`;
}

describe('pingDatabase', () => {
  it('sends one select on its own connection and gives it back to the pool', async () => {
    for (const kind of ['app', 'reader'] as const) {
      const { db, clients } = pool(kind, answered);
      await pingDatabase(db as Database | PublishedDatabase);
      expect(clients).toHaveLength(1);
      expect(clients[0]?.sent).toEqual(['select 1']);
      // No argument means the client is healthy and goes back for reuse.
      expect(clients[0]?.released).toBeUndefined();
    }
  });

  it('fails with DB_UNAVAILABLE when no connection can be had', async () => {
    const { db } = pool('reader', answered, true);
    expect(await code(pingDatabase(db as PublishedDatabase))).toBe('DB_UNAVAILABLE');
  });

  it('fails with DB_UNAVAILABLE and drops the client when the query fails', async () => {
    const { db, clients } = pool('app', () => Promise.reject(new Error('Connection terminated')));
    expect(await code(pingDatabase(db as Database))).toBe('DB_UNAVAILABLE');
    expect(clients[0]?.released).toBe(true);
  });

  // A peer that stopped answering never sends an error, so the ping has to give up by itself
  // and must not leave a socket behind for the next caller.
  it('gives up after its timeout and destroys the socket', async () => {
    vi.useFakeTimers();
    try {
      const { db, clients } = pool('app', () => new Promise(() => undefined));
      const pending = code(pingDatabase(db as Database, 250));
      await vi.advanceTimersByTimeAsync(250);
      expect(await pending).toBe('DB_UNAVAILABLE');
      expect(clients[0]?.destroyed).toBe(true);
      expect(clients[0]?.released).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails with DB_UNAVAILABLE once the database is closed', async () => {
    const { db } = pool('app', answered);
    await closeDatabase(db);
    expect(await code(pingDatabase(db as Database))).toBe('DB_UNAVAILABLE');
  });

  it.each<[string, unknown]>([
    ['a plain object', {}],
    ['null', null],
  ])('refuses %s with DB_CONFIG_INVALID', async (_label, handle) => {
    expect(await code(pingDatabase(handle as Database))).toBe('DB_CONFIG_INVALID');
  });

  // The auth pool belongs to sign in alone; nothing that pings should hold one.
  it('refuses an auth handle', async () => {
    const { db, clients } = pool('auth', answered);
    expect(await code(pingDatabase(db as unknown as Database))).toBe('DB_CONFIG_INVALID');
    expect(clients).toHaveLength(0);
  });

  it.each([0, -1, 1.5, 10_001, Number.NaN])('refuses a timeout of %s ms', async (timeoutMs) => {
    const { db, clients } = pool('app', answered);
    expect(await code(pingDatabase(db as Database, timeoutMs))).toBe('DB_CONFIG_INVALID');
    expect(clients).toHaveLength(0);
  });
});

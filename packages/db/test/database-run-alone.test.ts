import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  databaseOverPool,
  runAloneOnApiKeyLimiter,
  runAloneOnAuth,
  type AuthDatabase,
  type Database,
} from '../src/database.ts';
import { rejected } from './support.ts';

type Answer = (text: string) => unknown;

const ok = (rows: unknown[] = []) => ({ command: 'SELECT', rows, rowCount: rows.length });
const fiveResults = (rows: unknown[]) => [ok(), ok(), ok(), ok(rows), ok()];
const serverError = (code: string) => Object.assign(new Error('server said no'), { code });

class ScriptedClient extends EventEmitter {
  readonly sent: string[] = [];
  released: unknown = 'not released';
  private readonly answer: Answer;

  constructor(answer: Answer) {
    super();
    this.answer = answer;
  }

  query(text: string): Promise<unknown> {
    this.sent.push(text);
    try {
      return Promise.resolve(this.answer(text));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  release(error?: unknown): void {
    this.released = error;
  }
}

function scripted(kind: 'auth' | 'app', answer: Answer, connectError?: Error) {
  const clients: ScriptedClient[] = [];
  const pool = {
    connect: () => {
      if (connectError !== undefined) return Promise.reject(connectError);
      const client = new ScriptedClient(answer);
      clients.push(client);
      return Promise.resolve(client);
    },
  };
  const db = databaseOverPool(pool as unknown as pg.Pool, kind, { statementTimeoutMs: 5000 });
  return { db, clients };
}

const runners = [
  [
    'auth',
    'auth',
    (db: unknown, statement: string, timeoutMs?: number) =>
      runAloneOnAuth(db as AuthDatabase, statement, timeoutMs === undefined ? {} : { timeoutMs }),
  ],
  [
    'API key limiter',
    'app',
    (db: unknown, statement: string, timeoutMs?: number) =>
      runAloneOnApiKeyLimiter(
        db as Database,
        statement,
        timeoutMs === undefined ? {} : { timeoutMs },
      ),
  ],
] as const;

describe.each(runners)('a statement run alone on the %s pool', (_label, kind, run) => {
  it('goes to the server in one message with its commit, and returns its rows', async () => {
    const { db, clients } = scripted(kind, () => fiveResults([{ count: 3 }]));
    const rows = await run(db, 'insert into t default values returning 3 as count', 1000);
    expect(rows).toEqual([{ count: 3 }]);
    const [client] = clients;
    expect(client?.sent).toHaveLength(1);
    const parts = client?.sent[0]?.split(';\n');
    expect(parts?.[0]).toBe('begin');
    expect(parts?.[1]).toBe('set local statement_timeout = 1000');
    expect(parts?.[2]).toMatch(/set_config\('drefyn\.organization_id', '', true\)/);
    expect(parts?.[2]).toMatch(/set_config\('drefyn\.project_id', '', true\)/);
    expect(parts?.[2]).toMatch(/set_config\('drefyn\.user_id', '', true\)/);
    expect(parts?.[2]).toMatch(/set_config\('drefyn\.actor_user_id', '', true\)/);
    expect(parts?.[3]).toBe('insert into t default values returning 3 as count');
    expect(parts?.[4]).toBe('commit');
    expect(client?.released).toBeUndefined();
  });

  it('uses the pool statement timeout when none is given', async () => {
    const { db, clients } = scripted(kind, () => fiveResults([]));
    await run(db, 'select 1');
    expect(clients[0]?.sent[0]).toContain('set local statement_timeout = 5000');
  });

  it('refuses a timeout of 0 before it takes a connection', async () => {
    const { db, clients } = scripted(kind, () => fiveResults([]));
    expect(await rejected(run(db, 'select 1', 0))).toMatchObject({ code: 'DB_CONFIG_INVALID' });
    expect(clients).toHaveLength(0);
  });

  it('rolls back and maps the error when the statement fails, then keeps the connection', async () => {
    const { db, clients } = scripted(kind, (text) => {
      if (text === 'rollback') return ok();
      throw serverError('57014');
    });
    expect(await rejected(run(db, 'select 1', 1000))).toMatchObject({ code: 'DB_TIMEOUT' });
    expect(clients[0]?.sent.at(-1)).toBe('rollback');
    expect(clients[0]?.released).toBeUndefined();
  });

  it('destroys the connection when the rollback fails too', async () => {
    const { db, clients } = scripted(kind, () => {
      throw serverError('57014');
    });
    expect(await rejected(run(db, 'select 1', 1000))).toMatchObject({ code: 'DB_TIMEOUT' });
    expect(clients[0]?.released).toBe(true);
  });

  it('destroys a connection that reported an error while it ran', async () => {
    const { db, clients } = scripted(kind, () => {
      clients[0]?.emit('error', new Error('connection reset'));
      return fiveResults([]);
    });
    await run(db, 'select 1', 1000);
    expect(clients[0]?.released).toBe(true);
  });

  it('refuses a statement that turned out to be more than one', async () => {
    const { db, clients } = scripted(kind, () => [...fiveResults([]), ok()]);
    expect(await rejected(run(db, 'select 1; select 2', 1000))).toMatchObject({
      code: 'DB_CONFIG_INVALID',
      message: 'a statement run alone must be one statement',
    });
    expect(clients[0]?.released).toBeUndefined();
  });

  it('refuses a reply that is not one result per statement', async () => {
    const { db } = scripted(kind, () => ok());
    expect(await rejected(run(db, 'select 1', 1000))).toMatchObject({
      code: 'DB_CONFIG_INVALID',
    });
  });

  it('says the database is unavailable when no connection can be had', async () => {
    const { db } = scripted(kind, () => ok(), new Error('connect ECONNREFUSED'));
    expect(await rejected(run(db, 'select 1', 1000))).toMatchObject({ code: 'DB_UNAVAILABLE' });
  });

  it('refuses a handle that is not its own pool kind', async () => {
    const other = scripted(kind === 'auth' ? 'app' : 'auth', () => fiveResults([]));
    expect(await rejected(run(other.db, 'select 1', 1000))).toMatchObject({
      code: 'DB_CONFIG_INVALID',
    });
    expect(other.clients).toHaveLength(0);
  });
});

import { EventEmitter } from 'node:events';
import { organizationId, projectId, type OrganizationRef, type TenantRef } from '@drefyn/tenancy';
import { sql } from 'kysely';
import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  databaseOverPool,
  poolSizeOf,
  withOrganization,
  withTenant,
  type Database,
  type DbLogger,
} from '../src/database.ts';
import type { DbError } from '../src/errors.ts';
import { rejected } from './support.ts';

const ORG = organizationId('01a14984-4476-77ce-9335-2c3c3a59aa8b');
const PRJ = projectId('01a14984-4476-77ce-9335-2c3c3a59aa8c');
const TENANT: TenantRef = { organizationId: ORG, projectId: PRJ };

type Answer = (sql: string) => unknown;

// A pg client that records every query and answers from a script. Notices are emitted the
// way pg emits them, before the query resolves.
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
      return Promise.resolve(this.answer(text) ?? { command: 'SELECT', rows: [], rowCount: 0 });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  release(error?: unknown): void {
    this.released = error;
  }
}

function scripted(answer: Answer = () => undefined, logger?: DbLogger) {
  const clients: ScriptedClient[] = [];
  const pool = {
    connect: () => {
      const client = new ScriptedClient(answer);
      clients.push(client);
      return Promise.resolve(client);
    },
  };
  const db = databaseOverPool(pool as unknown as pg.Pool, 'app', {
    statementTimeoutMs: 5000,
    ...(logger === undefined ? {} : { logger }),
  }) as Database;
  return { db, clients };
}

const serverError = (code: string, message: string) => Object.assign(new Error(message), { code });

describe('context refusals happen before any SQL', () => {
  it.each<[string, unknown, string]>([
    ['withTenant with an OrganizationRef', { organizationId: ORG }, 'DB_TENANT_CONTEXT_MISSING'],
    [
      'withTenant with projectId undefined',
      { organizationId: ORG, projectId: undefined },
      'DB_TENANT_CONTEXT_MISSING',
    ],
    [
      'withTenant with a getter project',
      Object.defineProperty({ organizationId: ORG }, 'projectId', {
        get: () => PRJ,
        enumerable: true,
      }),
      'DB_TENANT_CONTEXT_MISSING',
    ],
  ])('%s', async (_label, ctx, code) => {
    const { db, clients } = scripted();
    const error = await rejected(withTenant(db, ctx as TenantRef, () => Promise.resolve(1)));
    expect((error as DbError).code).toBe(code);
    expect(clients).toHaveLength(0);
  });

  it.each<[string, unknown]>([
    ['a TenantRef', TENANT],
    ['projectId undefined', { organizationId: ORG, projectId: undefined }],
  ])('withOrganization with %s', async (_label, ctx) => {
    const { db, clients } = scripted();
    const error = await rejected(
      withOrganization(db, ctx as OrganizationRef, () => Promise.resolve(1)),
    );
    expect((error as DbError).code).toBe('DB_TENANT_CONTEXT_INVALID');
    expect(clients).toHaveLength(0);
  });
});

describe('the end of every transaction', () => {
  it('checks the context in the commit, resets the session and returns the client', async () => {
    const { db, clients } = scripted();
    await expect(withTenant(db, TENANT, () => Promise.resolve('ok'))).resolves.toBe('ok');
    const [client] = clients;
    const sent = client?.sent ?? [];
    expect(sent[0]).toMatch(/^begin; set local statement_timeout = 5000$/);
    expect(sent.slice(1, 4).every((q) => q.includes('set_config'))).toBe(true);
    expect(sent[4]).toMatch(
      /drefyn\.organization_id[\s\S]*drefyn\.project_id[\s\S]*drefyn\.user_id[\s\S]*drefyn\.actor_user_id[\s\S]*; commit$/,
    );
    expect(sent[4]).toContain(ORG);
    expect(sent[4]).toContain(PRJ);
    expect(sent[5]).toBe('discard all');
    expect(client?.released).toBeUndefined();
  });

  it('organization scope checks an empty project', async () => {
    const { db, clients } = scripted();
    await withOrganization(db, { organizationId: ORG }, () => Promise.resolve(1));
    expect(clients[0]?.sent[4]).toMatch(/drefyn\.project_id', true\) is distinct from ''/);
  });

  it('destroys the client when the reset fails, after a commit that did land', async () => {
    const { db, clients } = scripted((text) => {
      if (text === 'discard all') throw serverError('57P01', 'terminating connection');
      return undefined;
    });
    await expect(withTenant(db, TENANT, () => Promise.resolve('kept'))).resolves.toBe('kept');
    expect(clients[0]?.released).toBe(true);
  });

  it('rejects and destroys the client when the work ended the transaction itself', async () => {
    const warnings: [string, unknown][] = [];
    const logger: DbLogger = { warn: (event, fields) => warnings.push([event, fields]) };
    let client: ScriptedClient | undefined;
    const answer: Answer = (text) => {
      if (text === 'rollback') client?.emit('notice', { code: '25P01', message: 'no transaction' });
      return undefined;
    };
    const { db, clients } = scripted(answer, logger);
    const error = await rejected(
      withTenant(db, TENANT, async (tx) => {
        client = clients[0];
        await sql`select 1`.execute(tx);
        throw new Error('work failed');
      }),
    );
    expect((error as DbError).code).toBe('DB_TRANSACTION_INVALID');
    expect(clients[0]?.released).toBe(true);
    expect(warnings).toEqual([
      ['db_transaction_invalid', { pool: 'app', organization_id: ORG, project_id: PRJ }],
    ]);
    expect(JSON.stringify(warnings)).not.toMatch(/select|rollback/i);
  });

  it('keeps the client after a plain failure that rolled back cleanly', async () => {
    const { db, clients } = scripted();
    const thrown = new Error('work failed');
    expect(await rejected(withTenant(db, TENANT, () => Promise.reject(thrown)))).toBe(thrown);
    expect(clients[0]?.sent.slice(-2)).toEqual(['rollback', 'discard all']);
    expect(clients[0]?.released).toBeUndefined();
  });

  it('survives a logger that throws', async () => {
    let client: ScriptedClient | undefined;
    const { db, clients } = scripted(
      (text) => {
        if (text === 'rollback') client?.emit('notice', { code: '25P01', message: 'x' });
        return undefined;
      },
      {
        warn: () => {
          throw new Error('logger down');
        },
      },
    );
    const error = await rejected(
      withTenant(db, TENANT, () => {
        client = clients[0];
        return Promise.reject(new Error('x'));
      }),
    );
    expect((error as DbError).code).toBe('DB_TRANSACTION_INVALID');
  });

  it('ignores notices that are not about the transaction', async () => {
    let client: ScriptedClient | undefined;
    const { db, clients } = scripted((text) => {
      if (text.endsWith('; commit')) client?.emit('notice', { code: '00000', message: 'note' });
      return undefined;
    });
    await expect(
      withTenant(db, TENANT, () => {
        client = clients[0];
        return Promise.resolve('ok');
      }),
    ).resolves.toBe('ok');
    expect(clients[0]?.released).toBeUndefined();
  });

  it('rolls back and passes on a failure at commit, such as a serialization error', async () => {
    const failure = serverError('40001', 'could not serialize access');
    const { db, clients } = scripted((text) => {
      if (text.endsWith('; commit')) throw failure;
      return undefined;
    });
    expect(await rejected(withTenant(db, TENANT, () => Promise.resolve(1)))).toBe(failure);
    expect(clients[0]?.sent.slice(-2)).toEqual(['rollback', 'discard all']);
  });
});

describe('a work that catches a statement error', () => {
  it('still commits after a server error, as Postgres decides what the commit does', async () => {
    const { db, clients } = scripted((text) => {
      if (text.includes('select fails')) throw serverError('23505', 'duplicate key');
      return undefined;
    });
    await expect(
      withTenant(db, TENANT, (tx) =>
        sql`select fails`.execute(tx).catch(() => 'handled after a savepoint'),
      ),
    ).resolves.toBe('handled after a savepoint');
    expect(clients[0]?.sent.at(-2)).toContain('commit');
  });

  it('does not commit after a client timeout, which Postgres never heard of', async () => {
    const { db, clients } = scripted((text) => {
      if (text.includes('select slow')) throw new Error('Query read timeout');
      return undefined;
    });
    const failed = await rejected(
      withTenant(db, TENANT, (tx) => sql`select slow`.execute(tx).catch(() => undefined)),
    );
    expect(failed).toMatchObject({ code: 'DB_UNAVAILABLE' });
    expect(clients[0]?.sent.slice(-2)).toEqual(['rollback', 'discard all']);
  });
});

// A socket that stopped answering: the query never comes back until the socket is destroyed, which
// is what a real client does to its active query.
class HungClient extends ScriptedClient {
  ended = 0;
  readonly connection = {
    stream: {
      destroy: () => {
        this.destroyed();
      },
    },
  };
  private abandon: (error: Error) => void = () => undefined;

  override query(text: string): Promise<unknown> {
    if (!text.includes('hang_forever')) return super.query(text);
    this.sent.push(text);
    return new Promise((_done, fail) => {
      this.abandon = fail;
    });
  }

  private destroyed(): void {
    this.ended += 1;
    this.abandon(new Error('Connection terminated'));
  }
}

function hung(logger?: DbLogger) {
  const client = new HungClient(() => undefined);
  const pool = { connect: () => Promise.resolve(client) };
  const db = databaseOverPool(pool as unknown as pg.Pool, 'app', {
    statementTimeoutMs: 5000,
    ...(logger === undefined ? {} : { logger }),
  }) as Database;
  return { db, client };
}

describe('a deadline on a transaction', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const hanging = (db: Database, deadlineMs: number) =>
    withTenant(db, TENANT, (tx) => sql`select hang_forever`.execute(tx), { deadlineMs });

  it('closes a socket that stopped answering, and the connection never goes back', async () => {
    vi.useFakeTimers();
    const warn = vi.fn<DbLogger['warn']>();
    const { db, client } = hung({ warn });
    const failure = rejected(hanging(db, 1000));
    await vi.advanceTimersByTimeAsync(999);
    expect(client.ended).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await failure).toMatchObject({ code: 'DB_UNAVAILABLE' });
    expect(client.ended).toBeGreaterThan(0);
    expect(client.released).toBe(true);
    expect(client.sent.join()).not.toContain('discard all');
    expect(warn).toHaveBeenCalledWith('db_transaction_deadline', {
      pool: 'app',
      organization_id: ORG,
      project_id: PRJ,
      deadline_ms: 1000,
    });
  });

  it('leaves a transaction that ends in time alone', async () => {
    vi.useFakeTimers();
    const { db, client } = hung();
    await withTenant(db, TENANT, () => Promise.resolve(1), { deadlineMs: 1000 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.ended).toBe(0);
    expect(client.released).toBeUndefined();
  });

  it('sets no timer unless asked, so nothing else changes', async () => {
    vi.useFakeTimers();
    const { db } = hung();
    await withTenant(db, TENANT, () => Promise.resolve(1));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('survives a logger that throws', async () => {
    vi.useFakeTimers();
    const { db, client } = hung({
      warn: () => {
        throw new Error('logger down');
      },
    });
    const failure = rejected(hanging(db, 10));
    await vi.advanceTimersByTimeAsync(10);
    expect(await failure).toMatchObject({ code: 'DB_UNAVAILABLE' });
    expect(client.released).toBe(true);
  });

  it.each([0, -1, 1.5, 300_001, Number.NaN])('refuses %s before any SQL', async (deadlineMs) => {
    const { db, clients } = scripted();
    const error = await rejected(hanging(db, deadlineMs));
    expect((error as DbError).code).toBe('DB_CONFIG_INVALID');
    expect(clients).toHaveLength(0);
  });
});

describe('poolSizeOf', () => {
  it('reads the size the pool was built with', () => {
    const pool = { options: { max: 7 } };
    const db = databaseOverPool(pool as unknown as pg.Pool, 'app', {
      statementTimeoutMs: 5000,
    }) as Database;
    expect(poolSizeOf(db)).toBe(7);
  });

  it('refuses anything else', () => {
    expect(() => poolSizeOf({} as Database)).toThrow(/poolSizeOf/);
  });
});

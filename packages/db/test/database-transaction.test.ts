import { EventEmitter } from 'node:events';
import { organizationId, projectId, type OrganizationRef, type TenantRef } from '@drefyn/tenancy';
import { sql } from 'kysely';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  databaseOverPool,
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
      /drefyn\.organization_id[\s\S]*drefyn\.project_id[\s\S]*drefyn\.user_id[\s\S]*; commit$/,
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

import { EventEmitter } from 'node:events';
import {
  organizationId,
  projectId,
  userId,
  type OrganizationRef,
  type TenantRef,
  type UserRef,
} from '@drefyn/tenancy';
import fc from 'fast-check';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  databaseOverPool,
  withAuth,
  withOrganization,
  withPublishedReader,
  withTenant,
  withUser,
  type AuthDatabase,
  type Database,
  type DbLogger,
  type PublishedDatabase,
} from '../src/database.ts';
import type { DbError } from '../src/errors.ts';
import { userSettings } from '../src/tenant-context.ts';
import { rejected, thrown } from './support.ts';

const ORG = organizationId('01a14984-4476-77ce-9335-2c3c3a59aa8b');
const PRJ = projectId('01a14984-4476-77ce-9335-2c3c3a59aa8c');
const USR = userId('01a14984-4476-77ce-9335-2c3c3a59aa8d');
const USER: UserRef = { userId: USR };

type Answer = (sql: string) => unknown;

class ScriptedClient extends EventEmitter {
  readonly sent: { text: string; values: readonly unknown[] }[] = [];
  released: unknown = 'not released';
  private readonly answer: Answer;

  constructor(answer: Answer) {
    super();
    this.answer = answer;
  }

  query(text: string, values: readonly unknown[] = []): Promise<unknown> {
    this.sent.push({ text, values });
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

function scripted(kind: 'app' | 'auth' | 'reader', answer: Answer = () => undefined) {
  const clients: ScriptedClient[] = [];
  const warnings: [string, unknown][] = [];
  const logger: DbLogger = { warn: (event, fields) => warnings.push([event, fields]) };
  const pool = {
    connect: () => {
      const client = new ScriptedClient(answer);
      clients.push(client);
      return Promise.resolve(client);
    },
  };
  const db = databaseOverPool(pool as unknown as pg.Pool, kind, {
    statementTimeoutMs: 2000,
    logger,
  });
  return { db, clients, warnings };
}

const app = () => {
  const s = scripted('app');
  return { ...s, db: s.db as Database };
};
const auth = (answer?: Answer) => {
  const s = scripted('auth', answer);
  return { ...s, db: s.db as AuthDatabase };
};

const code = (error: unknown) => (error as DbError).code;

describe('withUser refuses a bad context before any SQL', () => {
  it.each<[string, unknown, string]>([
    ['an organizationId', { userId: USR, organizationId: ORG }, 'DB_TENANT_CONTEXT_INVALID'],
    ['a projectId', { userId: USR, projectId: PRJ }, 'DB_TENANT_CONTEXT_INVALID'],
    [
      'an organizationId of undefined',
      { userId: USR, organizationId: undefined },
      'DB_TENANT_CONTEXT_INVALID',
    ],
    [
      'a TenantRef with a user',
      { userId: USR, organizationId: ORG, projectId: PRJ },
      'DB_TENANT_CONTEXT_INVALID',
    ],
    ['an extra key', { userId: USR, role: 'owner' }, 'DB_TENANT_CONTEXT_INVALID'],
    ['an upper case id', { userId: USR.toUpperCase() }, 'DB_TENANT_CONTEXT_INVALID'],
    ['an id that is not a string', { userId: 42 }, 'DB_TENANT_CONTEXT_INVALID'],
    [
      'a getter id',
      Object.defineProperty({}, 'userId', { get: () => USR, enumerable: true }),
      'DB_TENANT_CONTEXT_INVALID',
    ],
    [
      'a class instance',
      new (class {
        userId = USR;
      })(),
      'DB_TENANT_CONTEXT_INVALID',
    ],
    ['an inherited id', Object.create({ userId: USR }) as unknown, 'DB_TENANT_CONTEXT_MISSING'],
    ['no userId', {}, 'DB_TENANT_CONTEXT_MISSING'],
    ['a userId of undefined', { userId: undefined }, 'DB_TENANT_CONTEXT_MISSING'],
    ['null', null, 'DB_TENANT_CONTEXT_MISSING'],
    ['a string', USR, 'DB_TENANT_CONTEXT_MISSING'],
  ])('%s', async (_label, ctx, expected) => {
    const { db, clients } = app();
    const error = await rejected(withUser(db, ctx as UserRef, () => Promise.resolve(1)));
    expect(code(error)).toBe(expected);
    expect(clients).toHaveLength(0);
  });

  it('refuses any malformed user id, whatever it holds', async () => {
    const canonical = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const value = fc.oneof(
      fc.string(),
      fc.uuid().map((u) => u.toUpperCase()),
      fc.uuid().map((u) => ` ${u}`),
      fc.uuid().map((u) => `${u}'; select 1; --`),
      fc.uuid().map((u) => u.replaceAll('-', '')),
      fc.integer(),
      fc.constant(null),
      fc.array(fc.uuid(), { maxLength: 2 }),
    );
    await fc.assert(
      fc.asyncProperty(value, async (candidate) => {
        fc.pre(!(typeof candidate === 'string' && canonical.test(candidate)));
        const { db, clients } = app();
        const error = await rejected(
          withUser(db, { userId: candidate } as unknown as UserRef, () => Promise.resolve(1)),
        );
        expect(code(error)).toBe('DB_TENANT_CONTEXT_INVALID');
        expect(clients).toHaveLength(0);
      }),
      { seed: 127, numRuns: 300 },
    );
  });
});

// A user context and an organization context in one transaction would let their permissive
// policies combine, so each entry point refuses the other's key.
describe('the tenant entry points refuse a user', () => {
  it.each<[string, (db: Database) => Promise<unknown>]>([
    [
      'withTenant',
      (db) =>
        withTenant(
          db,
          { ...({ organizationId: ORG, projectId: PRJ } as TenantRef), userId: USR } as TenantRef,
          () => Promise.resolve(1),
        ),
    ],
    [
      'withOrganization',
      (db) =>
        withOrganization(db, { organizationId: ORG, userId: USR } as OrganizationRef, () =>
          Promise.resolve(1),
        ),
    ],
  ])('%s with a userId', async (_label, call) => {
    const { db, clients } = app();
    expect(code(await rejected(call(db)))).toBe('DB_TENANT_CONTEXT_INVALID');
    expect(clients).toHaveLength(0);
  });

  it('withPublishedReader with a userId', async () => {
    const { db, clients } = scripted('reader');
    const error = await rejected(
      withPublishedReader(
        db as PublishedDatabase,
        { organizationId: ORG, projectId: PRJ, userId: USR } as TenantRef,
        () => Promise.resolve(1),
      ),
    );
    expect(code(error)).toBe('DB_TENANT_CONTEXT_INVALID');
    expect(clients).toHaveLength(0);
  });
});

describe('userSettings', () => {
  it('sets the user and leaves organization and project empty', () => {
    expect(userSettings({ userId: USR })).toEqual({
      organizationId: '',
      projectId: '',
      userId: USR,
    });
  });

  it('names the keys a user context may hold', () => {
    const error = thrown(() => userSettings({ userId: USR, other: 1 }));
    expect((error as Error).message).toContain('userId');
    expect((error as Error).message).not.toContain('projectId');
  });
});

describe('a user transaction', () => {
  it('sets only the user, then checks all three settings in the commit', async () => {
    const { db, clients } = app();
    await expect(withUser(db, USER, () => Promise.resolve('ok'))).resolves.toBe('ok');
    const sent = clients[0]?.sent ?? [];
    expect(sent[0]?.text).toBe('begin; set local statement_timeout = 2000');
    expect(sent.slice(1, 4).map((q) => [q.text.match(/drefyn\.[a-z_]+/)?.[0], q.values])).toEqual([
      ['drefyn.organization_id', ['']],
      ['drefyn.project_id', ['']],
      ['drefyn.user_id', [USR]],
    ]);
    const check = sent[4]?.text ?? '';
    expect(check).toMatch(/drefyn\.organization_id', true\) is distinct from ''/);
    expect(check).toMatch(/drefyn\.project_id', true\) is distinct from ''/);
    expect(check).toContain(`drefyn.user_id', true) is distinct from '${USR}'`);
    expect(check).toMatch(/; commit$/);
    expect(sent[5]?.text).toBe('discard all');
    expect(sent).toHaveLength(6);
    expect(clients[0]?.released).toBeUndefined();
  });

  // The guard's credential read must be the first statement the work sends, so nothing runs
  // in the user's context before the secret is compared.
  it('sends nothing between the settings and the work', async () => {
    const { db, clients } = app();
    let before = -1;
    await withUser(db, USER, () => {
      before = clients[0]?.sent.length ?? -1;
      return Promise.resolve();
    });
    expect(before).toBe(4);
  });

  it('logs a changed context without the user id', async () => {
    const answer: Answer = (text) => {
      if (text.endsWith('; commit')) throw Object.assign(new Error('changed'), { code: 'DRF01' });
      return undefined;
    };
    const s = scripted('app', answer);
    const error = await rejected(withUser(s.db as Database, USER, () => Promise.resolve(1)));
    expect(code(error)).toBe('DB_TRANSACTION_INVALID');
    expect(s.warnings).toEqual([['db_transaction_invalid', { pool: 'app', scope: 'user' }]]);
    expect(JSON.stringify(s.warnings)).not.toContain(USR);
    expect(s.clients[0]?.released).toBe(true);
  });

  it('tenant transactions set the user to empty', async () => {
    const { db, clients } = app();
    await withTenant(db, { organizationId: ORG, projectId: PRJ }, () => Promise.resolve(1));
    expect(clients[0]?.sent[3]).toEqual({
      text: "select set_config('drefyn.user_id', $1, true)",
      values: [''],
    });
    expect(clients[0]?.sent[4]?.text).toMatch(/drefyn\.user_id', true\) is distinct from ''/);
  });
});

describe('an auth transaction', () => {
  it('runs read write with every setting empty and resets the session', async () => {
    const { db, clients } = auth();
    await expect(withAuth(db, () => Promise.resolve('ok'))).resolves.toBe('ok');
    const sent = clients[0]?.sent ?? [];
    expect(sent[0]?.text).toBe('begin; set local statement_timeout = 2000');
    expect(sent.slice(1, 4).map((q) => q.values)).toEqual([[''], [''], ['']]);
    expect(sent[4]?.text).toMatch(/drefyn\.user_id', true\) is distinct from ''/);
    expect(sent[5]?.text).toBe('discard all');
  });

  it('takes a per call timeout up to 10000 ms', async () => {
    const { db, clients } = auth();
    await withAuth(db, () => Promise.resolve(1), { timeoutMs: 10_000 });
    expect(clients[0]?.sent[0]?.text).toBe('begin; set local statement_timeout = 10000');
    const error = await rejected(withAuth(db, () => Promise.resolve(1), { timeoutMs: 10_001 }));
    expect(code(error)).toBe('DB_CONFIG_INVALID');
  });

  it('logs a changed context with the pool and scope only', async () => {
    const answer: Answer = (text) => {
      if (text.endsWith('; commit')) throw Object.assign(new Error('changed'), { code: 'DRF01' });
      return undefined;
    };
    const s = scripted('auth', answer);
    await rejected(withAuth(s.db as AuthDatabase, () => Promise.resolve(1)));
    expect(s.warnings).toEqual([['db_transaction_invalid', { pool: 'auth', scope: 'auth' }]]);
  });
});

describe('each pool opens only its own transactions', () => {
  it('withUser refuses the auth pool', async () => {
    const { db } = auth();
    const error = await rejected(
      withUser(db as unknown as Database, USER, () => Promise.resolve(1)),
    );
    expect(code(error)).toBe('DB_CONFIG_INVALID');
  });

  it('withAuth refuses the app pool', async () => {
    const { db } = app();
    const error = await rejected(withAuth(db as unknown as AuthDatabase, () => Promise.resolve(1)));
    expect(code(error)).toBe('DB_CONFIG_INVALID');
  });

  it('withTenant refuses the auth pool', async () => {
    const { db } = auth();
    const error = await rejected(
      withTenant(db as unknown as Database, { organizationId: ORG, projectId: PRJ }, () =>
        Promise.resolve(1),
      ),
    );
    expect(code(error)).toBe('DB_CONFIG_INVALID');
  });
});

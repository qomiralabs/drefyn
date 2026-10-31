import type { CompiledQuery } from 'kysely';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
  type Transaction,
} from 'kysely';
import type { AuthSchema, OrganizationSchema, UserSchema } from '@drefyn/db';
import type { OrganizationId, UserId } from '@drefyn/tenancy';
import type { OrganizationStore, SessionStore } from '../src/index.ts';

export interface Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

export type Event =
  | { readonly kind: 'begin'; readonly scope: 'user' | 'auth'; readonly userId?: UserId }
  | {
      readonly kind: 'begin';
      readonly scope: 'organization';
      readonly organizationId: OrganizationId;
    }
  | { readonly kind: 'statement'; readonly statement: Statement }
  | { readonly kind: 'commit' }
  | { readonly kind: 'rollback' };

// Rows for one statement, or a throw to fail it like the database would.
export type Responder = (statement: Statement) => readonly Record<string, unknown>[];

const WRITE = /^\s*(insert|update|delete|merge)\b/i;

export const isWrite = (statement: Statement) =>
  WRITE.test(statement.sql) || /\b(insert into|update|delete from)\b/i.test(statement.sql);

// A store whose transactions run on a Kysely with no database behind it: every statement the
// code sends is recorded and answered by the test, and begin, commit and rollback are
// recorded in order, so a test can say exactly what reached the wire.
export function scriptedStore(respond: Responder = () => []) {
  const events: Event[] = [];
  let open = 0;
  let responder = respond;

  const connection: DatabaseConnection = {
    executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      const statement = { sql: query.sql, parameters: query.parameters };
      events.push({ kind: 'statement', statement });
      try {
        const rows = responder(statement) as R[];
        return Promise.resolve({ rows, numAffectedRows: BigInt(rows.length) });
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    streamQuery() {
      throw new Error('streaming is not scripted');
    },
  };

  const driver: Driver = {
    init: () => Promise.resolve(),
    acquireConnection: () => Promise.resolve(connection),
    beginTransaction: () => {
      open += 1;
      return Promise.resolve();
    },
    commitTransaction: () => {
      open -= 1;
      events.push({ kind: 'commit' });
      return Promise.resolve();
    },
    rollbackTransaction: () => {
      open -= 1;
      events.push({ kind: 'rollback' });
      return Promise.resolve();
    },
    releaseConnection: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };

  const kysely = new Kysely<UserSchema & AuthSchema & OrganizationSchema>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });

  const store: SessionStore & OrganizationStore = {
    user<T>(userId: UserId, work: (tx: Transaction<UserSchema>) => Promise<T>): Promise<T> {
      events.push({ kind: 'begin', scope: 'user', userId });
      return kysely.transaction().execute((tx) => work(tx as unknown as Transaction<UserSchema>));
    },
    auth<T>(work: (tx: Transaction<AuthSchema>) => Promise<T>): Promise<T> {
      events.push({ kind: 'begin', scope: 'auth' });
      return kysely.transaction().execute((tx) => work(tx as unknown as Transaction<AuthSchema>));
    },
    organization<T>(
      organizationId: OrganizationId,
      work: (tx: Transaction<OrganizationSchema>) => Promise<T>,
    ): Promise<T> {
      events.push({ kind: 'begin', scope: 'organization', organizationId });
      return kysely
        .transaction()
        .execute((tx) => work(tx as unknown as Transaction<OrganizationSchema>));
    },
  };

  return {
    store,
    events,
    get open() {
      return open;
    },
    respondWith(next: Responder) {
      responder = next;
    },
    statements(): Statement[] {
      return events.flatMap((e) => (e.kind === 'statement' ? [e.statement] : []));
    },
    writes(): Statement[] {
      return this.statements().filter(isWrite);
    },
    clear() {
      events.splice(0);
    },
  };
}

export type ScriptedStore = ReturnType<typeof scriptedStore>;

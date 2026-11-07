import type { TenantSchema } from '@drefyn/db';
import type { CompiledQuery } from 'kysely';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import type { EngineStore } from '../../src/index.ts';
import { createPoolGate, type PoolGate } from '../../src/pool-gate.ts';

export interface Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

export type Responder = (statement: Statement) => readonly Record<string, unknown>[];

export const roomyGate = (): PoolGate =>
  createPoolGate({
    ceiling: 1000,
    queued: 1000,
    waitMs: 1000,
    treeSlots: 2,
    listsPerOrganization: 4,
  });

// A Kysely with no database behind it, so a test can say exactly what reached the wire and how
// a transaction ended without a server.
export function scriptedStore(respond: Responder, gate: PoolGate = roomyGate()) {
  const statements: Statement[] = [];
  const ends: ('commit' | 'rollback')[] = [];

  const connection: DatabaseConnection = {
    executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      const statement = { sql: query.sql, parameters: query.parameters };
      statements.push(statement);
      try {
        return Promise.resolve({ rows: respond(statement) as R[] });
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
    beginTransaction: () => Promise.resolve(),
    commitTransaction: () => {
      ends.push('commit');
      return Promise.resolve();
    },
    rollbackTransaction: () => {
      ends.push('rollback');
      return Promise.resolve();
    },
    releaseConnection: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };

  const kysely = new Kysely<TenantSchema>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });

  const store: EngineStore = {
    gate,
    tenant: (_tenant, work) => kysely.transaction().execute(work),
  };

  return { store, statements, ends };
}

import type { PublishedSchema, TenantSchema } from '@drefyn/db';
import type { TenantRef } from '@drefyn/tenancy';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import type { RetrievalReader, TermStore } from '../../src/index.ts';

export interface Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

export type Responder = (statement: Statement) => readonly Record<string, unknown>[];

// A Kysely with no database behind it, so a unit test can say exactly what reached the wire
// and answer it as the database would.
function scriptedKysely<S>(respond: Responder) {
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
  const kysely = new Kysely<S>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { kysely, statements, ends };
}

export interface ReaderCall {
  readonly tenant: TenantRef;
  readonly timeoutMs: number;
}

export function scriptedReader(respond: Responder) {
  const { kysely, statements, ends } = scriptedKysely<PublishedSchema>(respond);
  const calls: ReaderCall[] = [];
  const reader: RetrievalReader = {
    read: (tenant, timeoutMs, work) => {
      calls.push({ tenant, timeoutMs });
      return kysely.transaction().execute(work);
    },
  };
  return { reader, statements, ends, calls };
}

export function scriptedTermStore(respond: Responder) {
  const { kysely, statements, ends } = scriptedKysely<TenantSchema>(respond);
  const tenants: TenantRef[] = [];
  const store: TermStore = {
    write: (tenant, work) => {
      tenants.push(tenant);
      return kysely.transaction().execute(work);
    },
  };
  return { store, statements, ends, tenants };
}

export interface LogLine {
  readonly level: 'info' | 'warn';
  readonly event: string;
  readonly fields: Readonly<Record<string, string | number | boolean>>;
}

export function capturedLogger() {
  const lines: LogLine[] = [];
  return {
    lines,
    logger: {
      info: (event: string, fields: LogLine['fields']) => {
        lines.push({ level: 'info', event, fields });
      },
      warn: (event: string, fields: LogLine['fields']) => {
        lines.push({ level: 'warn', event, fields });
      },
    },
  };
}

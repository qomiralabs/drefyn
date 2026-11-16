import type { TenantSchema } from '@drefyn/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type RawBuilder,
} from 'kysely';

// Compiles without a server, so a fuzz run can read the exact text a statement would send.
const offline = new Kysely<TenantSchema>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

export function compileProbe(raw: RawBuilder<unknown>): {
  readonly text: string;
  readonly parameters: readonly unknown[];
} {
  const { sql: text, parameters } = raw.compile(offline);
  return { text, parameters };
}

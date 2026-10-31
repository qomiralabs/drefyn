import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import { sql, type Transaction } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import { ALLOW_LISTS, type AllowLists } from '../../src/allow-lists.ts';
import { runCheckCatalog } from '../../src/catalog-check.ts';
import { DbError } from '../../src/errors.ts';
import {
  closeDatabase,
  createDatabase,
  withOrganization,
  withTenant,
  type Database,
} from '../../src/index.ts';
import { rejected } from '../support.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { until } from './support/process.ts';
import { query } from './support/sql.ts';
import { superuser } from './support/stack.ts';
import {
  appConfig,
  backendsOf,
  catalogProblems,
  context,
  fixtureTemplate,
  one,
  pools,
  rows,
  seed,
  seedProject,
} from './support/tenancy.ts';

const dbs = databases();
const fixture = fixtureTemplate(dbs);
const open = pools();

const ORG = organizationId('01a14984-4476-77ce-9335-50000000000a');
const PRJ = projectId('01a14984-4476-77ce-9335-5000000000a1');
const TENANT: TenantRef = { organizationId: ORG, projectId: PRJ };

let db: TestDatabase;

const terminate = (pid: number) =>
  superuser(`select pg_terminate_backend(${String(pid)});`, db.name);

describeWithStack('withTenant when the connection goes away', () => {
  let app: Database;

  beforeAll(async () => {
    db = await fixture();
    await seedProject(db.app, ORG, PRJ);
    await seed(db.app, ORG, PRJ, [
      {
        text: "insert into app.fixture_notes (organization_id, project_id, body) values ($1, $2, 'kept')",
        values: [ORG, PRJ],
      },
    ]);
    app = await open.app(db.app, { DREFYN_DATABASE_POOL_MAX: '1' });
  });

  it('survives an idle pooled connection being killed and opens a new one', async () => {
    const { pid } = await withTenant(app, TENANT, (tx) => one(tx, context));
    await terminate(pid);
    await until(async () => !(await backendsOf('drefyn_app', db.name)).some((b) => b.pid === pid), {
      timeoutMs: 5000,
      what: `backend ${String(pid)} to go`,
    });
    let after: { org: string | null; project: string | null; pid: number } | null = null;
    await until(
      async () => {
        after = await withTenant(app, TENANT, (tx) => one(tx, context)).catch(() => null);
        return after !== null && after.pid !== pid;
      },
      { timeoutMs: 5000, what: 'a fresh connection' },
    );
    expect(after).toMatchObject({ org: ORG, project: PRJ });
  });

  // The process must not crash on the client's error event, the transaction must fail, and
  // the dead client must never go back to the pool.
  it('fails the transaction and drops the client when it is killed mid work', async () => {
    let killed = 0;
    const error = await rejected(
      withTenant(app, TENANT, async (tx) => {
        killed = (await one(tx, context)).pid;
        await terminate(killed);
        await new Promise((resolve) => setTimeout(resolve, 100));
        return rows(tx, sql`select body from app.fixture_notes`);
      }),
    );
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe('DB_UNAVAILABLE');
    const next = await withTenant(app, TENANT, (tx) => one(tx, context));
    expect(next.pid).not.toBe(killed);
    expect(
      await withTenant(app, TENANT, (tx) => rows(tx, sql`select body from app.fixture_notes`)),
    ).toEqual([{ body: 'kept' }]);
  });

  it('refuses to stream, since the connection must stay inside the transaction', async () => {
    const error = await rejected(
      withTenant(app, TENANT, async (tx) => {
        // The fixture tables are not in the generated schema, so the transaction is cast.
        const fixtures = tx as unknown as Transaction<{ fixture_notes: { body: string } }>;
        const notes = fixtures.selectFrom('fixture_notes').selectAll();
        for await (const row of notes.stream()) {
          return row;
        }
        return undefined;
      }),
    );
    expect(String(error)).toMatch(/streaming is not supported/);
  });

  it('lets the work read the schema it can see through the transaction', async () => {
    const tables = await withTenant(app, TENANT, (tx) => tx.introspection.getTables());
    expect(tables.map((t) => t.name)).toContain('fixture_notes');
  });
});

describeWithStack('createDatabase over TLS to a server without it', () => {
  beforeAll(async () => {
    db = await fixture();
  });

  it('fails with DB_UNAVAILABLE naming the URL key', async () => {
    const error = await rejected(
      createDatabase(appConfig(db.app, { DREFYN_DATABASE_SSL: 'require' })),
    );
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe('DB_UNAVAILABLE');
    expect((error as DbError).message).toContain('DREFYN_DATABASE_URL');
  });
});

function output() {
  let text = '';
  return {
    stream: {
      write: (chunk: string) => {
        text += chunk;
        return true;
      },
    },
    text: () => text,
  };
}

describeWithStack('check:catalog in process', () => {
  beforeAll(async () => {
    db = await dbs.fresh('migrated');
  });

  const runIt = async () => {
    const out = output();
    const err = output();
    const code = await runCheckCatalog({
      env: { DREFYN_MIGRATION_DATABASE_URL: db.owner, DREFYN_DATABASE_SSL: 'disable' },
      stdout: out.stream,
      stderr: err.stream,
    });
    return { code, out: out.text(), err: err.text() };
  };

  it('exits 0 on the migrated database', async () => {
    const result = await runIt();
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain('check:catalog');
  });

  it('exits 1 with one line per problem', async () => {
    await query(db.owner, 'grant select on app.migration_checksums to drefyn_app');
    try {
      const result = await runIt();
      expect(result.code).toBe(1);
      expect(result.err).toMatch(/^check:catalog: bookkeeping_grant app\.migration_checksums: /m);
    } finally {
      await query(db.owner, 'revoke select on app.migration_checksums from drefyn_app');
    }
  });
});

describe('more catalog rules', () => {
  describeWithStack('on the fixture schema', () => {
    beforeAll(async () => {
      db = await fixture();
    });

    const problemsAfter = async (statements: string, allow: AllowLists = ALLOW_LISTS) => {
      for (const statement of statements.split(';\n')) await query(db.owner, statement);
      const fixtureAllow: AllowLists = {
        ...allow,
        publishedTables: [
          ...allow.publishedTables,
          { name: 'app.fixture_published', reason: 'test fixture, never shipped' },
        ],
      };
      return catalogProblems(db.owner, fixtureAllow);
    };

    it('passes a view with security_invoker and a reviewed SECURITY DEFINER function', async () => {
      const problems = await problemsAfter(
        `create view app.ok_view with (security_invoker = true) as select id from app.fixture_notes;
create function app.ok_definer() returns int language sql security definer as $$ select 1 $$`,
        {
          ...ALLOW_LISTS,
          securityDefinerFunctions: [{ name: 'app.ok_definer()', reason: 'test only' }],
        },
      );
      expect(problems).toEqual([]);
      await query(db.owner, 'drop view app.ok_view');
      await query(db.owner, 'drop function app.ok_definer()');
    });

    it.each([
      [
        'grant create on schema app to drefyn_public_reader',
        'revoke create on schema app from drefyn_public_reader',
        'reader_grant',
        'app',
      ],
      [
        'grant usage on schema app to public',
        'revoke usage on schema app from public',
        'reader_grant',
        'app',
      ],
      [
        'alter default privileges for role drefyn_owner grant select on tables to drefyn_public_reader',
        'alter default privileges for role drefyn_owner revoke select on tables from drefyn_public_reader',
        'default_privileges',
        'drefyn_public_reader',
      ],
    ])('fails after %s', async (grant, revoke, rule, object) => {
      try {
        const problems = await problemsAfter(grant);
        expect(problems).toContainEqual(expect.objectContaining({ rule, object }));
      } finally {
        await query(db.owner, revoke);
      }
    });

    it('fails on a database wide setting beyond the bootstrap search_path', async () => {
      await superuser(`alter database ${db.name} set work_mem = '64MB';`);
      try {
        const problems = await problemsAfter('select 1');
        expect(problems).toContainEqual(
          expect.objectContaining({ rule: 'role_setting', object: db.name }),
        );
      } finally {
        await superuser(`alter database ${db.name} reset work_mem;`);
      }
    });
  });
});

describeWithStack('createDatabase with a logger', () => {
  beforeAll(async () => {
    db = await fixture();
  });

  // Ids and the pool kind only: no SQL text and no values.
  it('reports a transaction the work ended itself, for both scopes', async () => {
    const warnings: [string, unknown][] = [];
    const app = await createDatabase(appConfig(db.app), {
      logger: { warn: (event, fields) => warnings.push([event, fields]) },
    });
    try {
      const commit = ['com', 'mit'].join('');
      await rejected(withTenant(app, TENANT, (tx) => sql.raw(commit).execute(tx)));
      await rejected(
        withOrganization(app, { organizationId: ORG }, (tx) => sql.raw(commit).execute(tx)),
      );
      expect(warnings).toEqual([
        ['db_transaction_invalid', { pool: 'app', organization_id: ORG, project_id: PRJ }],
        ['db_transaction_invalid', { pool: 'app', organization_id: ORG }],
      ]);
    } finally {
      await closeDatabase(app);
    }
  });
});

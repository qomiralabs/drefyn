import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { loadMigrationFiles, NO_TRANSACTION_MARKER } from '../src/migration-file.ts';
import { MigrateError } from '../src/outcome.ts';
import { clientConfig, sessionFor } from '../src/pg-session.ts';
import type { Output, RunRequest } from '../src/run.ts';
import { migrationText, migrationsDir, rejected } from './support.ts';

type Responder = (text: string, values: readonly unknown[]) => unknown[] | Error | undefined;

// Answers the queries node-pg-migrate and the session send, and records each one, so a test
// can read the exact SQL sequence a run would send to Postgres.
function fakeClient(respond: Responder = () => undefined) {
  const sent: string[] = [];
  const notices: ((notice: { code?: string; message: string }) => void)[] = [];
  const client = {
    query: (text: string, values: readonly unknown[] = []) => {
      sent.push(text.trim());
      if (text.startsWith('grant nothing')) {
        for (const listener of notices) {
          listener({ code: '01007', message: 'no privileges were granted for "extensions"' });
        }
      }
      const answer = respond(text, values);
      if (answer instanceof Error) return Promise.reject(answer);
      if (answer !== undefined) return Promise.resolve({ rows: answer });
      if (text.includes('information_schema.tables')) {
        return Promise.resolve({ rows: [{ table_name: 'pgmigrations' }] });
      }
      if (text.includes('information_schema.table_constraints')) {
        return Promise.resolve({ rows: [{ constraint_name: 'pgmigrations_pkey' }] });
      }
      return Promise.resolve({ rows: [] });
    },
    end: () => Promise.resolve(),
    on: (event: string, listener: (notice: { code?: string; message: string }) => void) => {
      if (event === 'notice') notices.push(listener);
    },
  };
  return { client: client as unknown as pg.Client, sent };
}

function capture(): Output & { text: () => string } {
  const chunks: string[] = [];
  return { write: (t: string) => void chunks.push(t), text: () => chunks.join('') };
}

const PLAIN = '1760000000001_widgets.sql';
const MARKED = '1760000000002_widgets_name_idx.sql';
const plain = migrationText('create table app.widgets (id int);', 'drop table app.widgets;');
const marked = `${NO_TRANSACTION_MARKER}\n${migrationText(
  'create index concurrently if not exists widgets_name_idx on app.widgets (id);',
  'drop index concurrently if exists app.widgets_name_idx;',
)}`;

async function request(
  dir: string,
  direction: 'up' | 'down',
  count = Number.POSITIVE_INFINITY,
): Promise<RunRequest & { out: ReturnType<typeof capture>; err: ReturnType<typeof capture> }> {
  const out = capture();
  const err = capture();
  const files = await loadMigrationFiles(dir);
  return { direction, count, dir, files, stdout: out, stderr: err, out, err };
}

// What ran from the first file statement on, without the tool's own catalog reads.
const fromFirstFile = (sent: readonly string[]) =>
  sent.slice(sent.findIndex((s) => s === 'BEGIN;' || s.startsWith('create index')));

describe('the runner wiring', () => {
  it('runs an unmarked file, its hash and its record in one transaction', async () => {
    const dir = migrationsDir({ [PLAIN]: plain });
    const { client, sent } = fakeClient();
    const files = await loadMigrationFiles(dir);
    const r = await request(dir, 'up');
    await sessionFor(client).run(r);
    expect(fromFirstFile(sent)).toEqual([
      'BEGIN;',
      'create table app.widgets (id int);',
      `insert into app.migration_checksums (name, sha256) values ('1760000000001_widgets', '${files[0]?.sha256 ?? ''}');`,
      `INSERT INTO "app"."pgmigrations" (name, run_on) VALUES ('1760000000001_widgets', NOW());`,
      'COMMIT;',
    ]);
    expect(sent).toContain('set statement_timeout = 0');
    expect(r.out.text()).toContain('1760000000001_widgets');
  });

  it('runs a marked file outside a transaction with an upsert for its hash', async () => {
    const dir = migrationsDir({ [MARKED]: marked });
    const { client, sent } = fakeClient();
    const r = await request(dir, 'up');
    await sessionFor(client).run(r);
    const run = fromFirstFile(sent);
    expect(run).not.toContain('BEGIN;');
    expect(run[0]).toBe(
      'create index concurrently if not exists widgets_name_idx on app.widgets (id);',
    );
    expect(run[1]).toMatch(
      /^insert into app\.migration_checksums .* on conflict \(name\) do update set sha256 = excluded\.sha256/,
    );
    expect(run[2]).toMatch(/^INSERT INTO "app"\."pgmigrations"/);
    expect(r.err.text()).toMatch(/not wrapped in a transaction/);
  });

  it('removes the hash with the record on down', async () => {
    const dir = migrationsDir({ [PLAIN]: plain });
    const { client, sent } = fakeClient((text) =>
      text.startsWith('SELECT name FROM "app"."pgmigrations"')
        ? [{ name: '1760000000001_widgets' }]
        : undefined,
    );
    await sessionFor(client).run(await request(dir, 'down', 1));
    expect(fromFirstFile(sent)).toEqual([
      'BEGIN;',
      'drop table app.widgets;',
      `delete from app.migration_checksums where name = '1760000000001_widgets';`,
      `DELETE FROM "app"."pgmigrations" WHERE name='1760000000001_widgets';`,
      'COMMIT;',
    ]);
  });

  // The tool hands any file it does not ignore to jiti, which runs it as code.
  it('never loads a stray script that appears in the folder', async () => {
    const dir = migrationsDir({ [PLAIN]: plain });
    const r = await request(dir, 'up');
    const marker = join(dir, 'ran');
    writeFileSync(
      join(dir, '1760000000003_stray.js'),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`,
    );
    const { client } = fakeClient();
    await sessionFor(client).run(r);
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses a migration file that appeared after the folder was read', async () => {
    const dir = migrationsDir({ [PLAIN]: plain });
    const r = await request(dir, 'up');
    writeFileSync(join(dir, '1760000000003_late.sql'), plain);
    const { client, sent } = fakeClient();
    const error = await rejected(sessionFor(client).run(r));
    expect(error).toBeInstanceOf(MigrateError);
    expect((error as MigrateError).message).toContain('1760000000003_late.sql');
    expect(sent).not.toContain('create table app.widgets (id int);');
  });

  it('fails a file whose grant changed nothing, before it commits', async () => {
    const dir = migrationsDir({
      [PLAIN]: migrationText('grant nothing;', 'select 1;'),
    });
    const { client, sent } = fakeClient();
    const error = await rejected(sessionFor(client).run(await request(dir, 'up')));
    expect((error as MigrateError).message).toMatch(
      /^1760000000001_widgets\.sql failed and was not recorded: no privileges were granted/,
    );
    expect(sent).not.toContain('COMMIT;');
  });

  it('names the file that failed', async () => {
    const dir = migrationsDir({ [PLAIN]: plain });
    const { client } = fakeClient((text) =>
      text.startsWith('create table') ? new Error('division by zero') : undefined,
    );
    const error = await rejected(sessionFor(client).run(await request(dir, 'up')));
    expect(error).toBeInstanceOf(MigrateError);
    expect((error as MigrateError).message).toBe(
      `${PLAIN} failed and was not recorded: division by zero`,
    );
  });

  it('passes on a failure before any file started as it is', async () => {
    const dir = migrationsDir({ [PLAIN]: plain });
    const boom = new Error('relation does not exist');
    const { client } = fakeClient((text) =>
      text.startsWith('SELECT name FROM') ? boom : undefined,
    );
    const error = await rejected(sessionFor(client).run(await request(dir, 'up')));
    expect(error).toBe(boom);
  });
});

describe('session queries', () => {
  it('reads the connected role', async () => {
    const { client } = fakeClient((text) =>
      text.includes('current_user')
        ? [{ name: 'drefyn_owner', superuser: false, bypass: true }]
        : undefined,
    );
    expect(await sessionFor(client).role()).toEqual({
      name: 'drefyn_owner',
      superuser: false,
      bypassRls: true,
    });
  });

  it('fails when the role cannot be read', async () => {
    const { client } = fakeClient();
    expect(await rejected(sessionFor(client).role())).toBeInstanceOf(MigrateError);
  });

  it('reads the vector extension, or nothing', async () => {
    const found = fakeClient((text) =>
      text.includes('pg_extension') ? [{ schema: 'extensions', version: '0.8.7' }] : undefined,
    );
    expect(await sessionFor(found.client).vectorExtension()).toEqual({
      schema: 'extensions',
      version: '0.8.7',
    });
    expect(await sessionFor(fakeClient().client).vectorExtension()).toBeUndefined();
  });

  it('tries the shared lock key and reports whether it got it', async () => {
    const got = fakeClient((text, values) => {
      if (text.includes('pg_try_advisory_lock')) {
        expect(values).toEqual(['7241865325823964']);
        return [{ locked: true }];
      }
      return undefined;
    });
    expect(await sessionFor(got.client).tryLock()).toBe(true);
    expect(await sessionFor(fakeClient().client).tryLock()).toBe(false);
  });

  it('rolls back before it unlocks, and sets a 2 s lock timeout', async () => {
    const { client, sent } = fakeClient();
    const session = sessionFor(client);
    await session.setLockTimeout();
    await session.unlock();
    await session.close();
    expect(sent).toEqual([
      "set lock_timeout = '2s'",
      'rollback',
      'select pg_advisory_unlock($1::bigint)',
    ]);
  });

  it.each([
    [[{ found: false, type: null }], undefined],
    [[{ found: true, type: 'timestamp with time zone' }], undefined],
  ])('accepts a tracking table that is absent or right (%j)', async (rows, expected) => {
    const { client } = fakeClient((text) => (text.includes('format_type') ? rows : undefined));
    expect(await sessionFor(client).trackingTableProblem()).toBe(expected);
  });

  it.each([
    [[{ found: true, type: 'timestamp without time zone' }], 'timestamp without time zone'],
    [[{ found: true, type: null }], 'missing'],
  ])('names run_on when the tracking table is wrong (%j)', async (rows, word) => {
    const { client } = fakeClient((text) => (text.includes('format_type') ? rows : undefined));
    const problem = await sessionFor(client).trackingTableProblem();
    expect(problem).toContain('app.pgmigrations.run_on');
    expect(problem).toContain(word);
  });

  it('reads no history when the tracking table is absent', async () => {
    const { client } = fakeClient((text) =>
      text.includes('to_regclass') ? [{ migrations: false, checksums: false }] : undefined,
    );
    expect(await sessionFor(client).history()).toEqual([]);
  });

  it('reads history with hashes, or without when the checksum table is gone', async () => {
    const both = fakeClient((text) => {
      if (text.includes('to_regclass')) return [{ migrations: true, checksums: true }];
      if (text.includes('left join'))
        return [
          { name: 'a', sha256: 'x' },
          { name: 'b', sha256: null },
        ];
      return undefined;
    });
    expect(await sessionFor(both.client).history()).toEqual([
      { name: 'a', sha256: 'x' },
      { name: 'b', sha256: undefined },
    ]);
    const tracking = fakeClient((text) => {
      if (text.includes('to_regclass')) return [{ migrations: true, checksums: false }];
      if (text.includes('null as sha256')) return [{ name: 'a', sha256: null }];
      return undefined;
    });
    expect(await sessionFor(tracking.client).history()).toEqual([{ name: 'a', sha256: undefined }]);
  });

  it('creates both bookkeeping tables and revokes everything on them in one statement', async () => {
    const { client, sent } = fakeClient();
    await sessionFor(client).ensureBookkeeping();
    expect(sent).toHaveLength(1);
    const sql = sent[0] ?? '';
    expect(sql).toMatch(/create table if not exists app\.pgmigrations/);
    expect(sql).toMatch(/run_on timestamptz not null/);
    expect(sql).toMatch(/create table if not exists app\.migration_checksums/);
    expect(sql).toMatch(
      /revoke all on app\.pgmigrations, app\.migration_checksums from public, drefyn_app, drefyn_public_reader;/,
    );
    expect(sql).toMatch(
      /revoke all on sequence app\.pgmigrations_id_seq from public, drefyn_app, drefyn_public_reader;/,
    );
  });
});

describe('clientConfig', () => {
  const config = (url: string, ssl: 'disable' | 'require' | 'verify-full' = 'verify-full') =>
    clientConfig({ url, ssl });

  it('sets every field from the URL, decoded', () => {
    expect(config('postgres://drefyn_owner:p%40ss%2Fw@db.example:6543/drefyn')).toMatchObject({
      host: 'db.example',
      port: 6543,
      user: 'drefyn_owner',
      password: 'p@ss/w',
      database: 'drefyn',
      application_name: 'drefyn-migrate',
      connectionTimeoutMillis: 10_000,
      statement_timeout: 30_000,
    });
  });

  it('defaults the port and unwraps an IPv6 host', () => {
    expect(config('postgres://u:p@[::1]/d')).toMatchObject({ host: '::1', port: 5432 });
  });

  it('maps each SSL mode', () => {
    const url = 'postgres://u:p@h/d';
    expect(config(url, 'disable').ssl).toBe(false);
    expect(config(url, 'require').ssl).toEqual({ rejectUnauthorized: false });
    expect(config(url, 'verify-full').ssl).toEqual({ rejectUnauthorized: true });
  });
});

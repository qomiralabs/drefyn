import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { loadMigrationFiles, NO_TRANSACTION_MARKER } from '../src/migration-file.ts';
import { MigrateError } from '../src/outcome.ts';
import { clientConfig, createClient, sessionFor } from '../src/pg-session.ts';
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
      if (text.startsWith('revoke nothing')) {
        for (const listener of notices) {
          listener({ code: '01006', message: 'no privileges could be revoked for "extensions"' });
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
const ORPHANS =
  'delete from app.migration_checksums c where not exists (select from app.pgmigrations m where m.name = c.name)';

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
      ORPHANS,
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
    expect(run[1]).toMatch(/^do \$\$/);
    expect(run[2]).toMatch(
      /^insert into app\.migration_checksums .* on conflict \(name\) do update set sha256 = excluded\.sha256/,
    );
    expect(run[3]).toMatch(/^INSERT INTO "app"\."pgmigrations"/);
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
      ORPHANS,
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

  it('fails a file whose revoke changed nothing, before it commits', async () => {
    const dir = migrationsDir({ [PLAIN]: migrationText('revoke nothing;', 'select 1;') });
    const { client, sent } = fakeClient();
    const error = await rejected(sessionFor(client).run(await request(dir, 'up')));
    expect((error as MigrateError).message).toMatch(/no privileges could be revoked/);
    expect(sent).not.toContain('COMMIT;');
  });

  // A crash between deleting the hash and deleting the record would leave a record with no
  // hash, which turns every later command into exit 3. The record goes first; the hash is
  // cleared afterwards as an orphan.
  it('removes the record of a marked file on down and only then its orphaned hash', async () => {
    const dir = migrationsDir({ [MARKED]: marked });
    const { client, sent } = fakeClient((text) =>
      text.startsWith('SELECT name FROM "app"."pgmigrations"')
        ? [{ name: '1760000000002_widgets_name_idx' }]
        : undefined,
    );
    await sessionFor(client).run(await request(dir, 'down', 1));
    const run = sent.slice(sent.indexOf('drop index concurrently if exists app.widgets_name_idx;'));
    expect(run[0]).toBe('drop index concurrently if exists app.widgets_name_idx;');
    expect(run[1]).toMatch(/^do \$\$/);
    expect(run[2]).toMatch(
      /^DELETE FROM "app"\."pgmigrations" WHERE name='1760000000002_widgets_name_idx'/,
    );
    expect(run.slice(3)).toEqual([ORPHANS]);
  });

  it('clears orphaned hashes after a run', async () => {
    const dir = migrationsDir({ [PLAIN]: plain });
    const { client, sent } = fakeClient();
    await sessionFor(client).run(await request(dir, 'up'));
    expect(sent.at(-1)).toBe(ORPHANS);
  });

  // The check sits between a marked section and its bookkeeping, so a failed or skipped build
  // can never be recorded as applied.
  describe('the invalid index check after a marked section', () => {
    const isCheck = (text: string) => text.includes('pg_index') && text.startsWith('do $$');

    it('runs after the section and before the hash and the record', async () => {
      const dir = migrationsDir({ [MARKED]: marked });
      const { client, sent } = fakeClient();
      await sessionFor(client).run(await request(dir, 'up'));
      const run = fromFirstFile(sent);
      expect(run[0]).toMatch(/^create index concurrently/);
      expect(isCheck(run[1] ?? '')).toBe(true);
      expect(run[2]).toMatch(/^insert into app\.migration_checksums/);
      expect(run[3]).toMatch(/^INSERT INTO "app"\."pgmigrations"/);
    });

    it('runs after a marked down section, before the record is removed', async () => {
      const dir = migrationsDir({ [MARKED]: marked });
      const { client, sent } = fakeClient((text) =>
        text.startsWith('SELECT name FROM "app"."pgmigrations"')
          ? [{ name: '1760000000002_widgets_name_idx' }]
          : undefined,
      );
      await sessionFor(client).run(await request(dir, 'down', 1));
      const run = sent.slice(
        sent.indexOf('drop index concurrently if exists app.widgets_name_idx;'),
      );
      expect(isCheck(run[1] ?? '')).toBe(true);
      expect(run[2]).toMatch(/^DELETE FROM "app"\."pgmigrations"/);
    });

    it.each([
      [
        'finds invalid indexes',
        new Error('invalid indexes in schema app: app.widgets_name_key on app.widgets'),
      ],
      ['itself fails', new Error('canceling statement due to user request')],
    ])('writes neither hash nor record when the check %s', async (_, failure) => {
      const dir = migrationsDir({ [MARKED]: marked });
      const { client, sent } = fakeClient((text) => (isCheck(text) ? failure : undefined));
      const error = await rejected(sessionFor(client).run(await request(dir, 'up')));
      expect((error as MigrateError).message).toContain(failure.message);
      expect(sent.some((t) => t.startsWith('insert into app.migration_checksums'))).toBe(false);
      expect(sent.some((t) => t.startsWith('INSERT INTO "app"."pgmigrations"'))).toBe(false);
    });

    it('is not run after an unmarked file, whose failed build rolls back', async () => {
      const dir = migrationsDir({ [PLAIN]: plain });
      const { client, sent } = fakeClient();
      await sessionFor(client).run(await request(dir, 'up'));
      expect(sent.some(isCheck)).toBe(false);
    });
  });

  describe('invalidIndexes', () => {
    it('reads invalid indexes in app with whether a build is running', async () => {
      const { client, sent } = fakeClient((text) =>
        text.includes('indisvalid')
          ? [{ index: 'widgets_name_key', table: 'widgets', building: true }]
          : undefined,
      );
      expect(await sessionFor(client).invalidIndexes()).toEqual([
        { index: 'widgets_name_key', table: 'widgets', building: true },
      ]);
      expect(sent[0]).toMatch(/nspname = 'app'/);
      expect(sent[0]).toMatch(/not x\.indisvalid/);
      expect(sent[0]).toMatch(/pg_stat_progress_create_index/);
    });
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
    // A crash between a marked file's statements can leave a hash with no record.
    expect(sql).toContain(`${ORPHANS};`);
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
      database: 'drefyn',
      application_name: 'drefyn-migrate',
      connectionTimeoutMillis: 10_000,
      statement_timeout: 30_000,
    });
  });

  it('decodes the password and hands it over through a function', async () => {
    const { password } = config('postgres://drefyn_owner:p%40ss%2Fw@db.example:6543/drefyn');
    expect(typeof password).toBe('function');
    expect(await (password as () => Promise<string>)()).toBe('p@ss/w');
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

// pg fills any setting left empty from PG* variables and ~/.pgpass. PGOPTIONS would set
// session settings for the migrate role, which the URL rule exists to prevent.
describe('createClient ignores the PG* environment', () => {
  const HOSTILE: Record<string, string> = {
    PGOPTIONS: '-c search_path=public -c lock_timeout=0',
    PGPASSWORD: 'from-the-environment',
    PGREPLICATION: 'database',
    PGBINARY: 'true',
    PGCLIENT_ENCODING: 'LATIN1',
    PGSSLNEGOTIATION: 'direct',
    PGPASSFILE: '/nonexistent/pgpass',
  };

  function withEnv<T>(values: Record<string, string>, work: () => T): T {
    const before = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
    Object.assign(process.env, values);
    try {
      return work();
    } finally {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  }

  interface Params {
    options?: unknown;
    replication?: unknown;
    binary?: unknown;
    client_encoding?: unknown;
    sslnegotiation?: unknown;
  }

  it('sends none of them, and leaves the environment as it was', () => {
    const client = withEnv(HOSTILE, () =>
      createClient({ url: 'postgres://drefyn_owner:pw@127.0.0.1:5432/drefyn', ssl: 'disable' }),
    );
    const params = (client as unknown as { connectionParameters: Params }).connectionParameters;
    // pg's own defaults may stand; nothing may come from the variables above.
    expect(params.options).toBeUndefined();
    expect(params.replication).toBeUndefined();
    expect(params.binary).not.toBe('true');
    expect(params.client_encoding).not.toBe('LATIN1');
    expect(params.sslnegotiation).toBeUndefined();
    expect(process.env['PGOPTIONS']).toBeUndefined();
  });

  it('answers with the URL password, never PGPASSWORD or a pgpass file', async () => {
    for (const url of [
      'postgres://drefyn_owner:pw@127.0.0.1:5432/drefyn',
      'postgres://drefyn_owner@127.0.0.1:5432/drefyn',
    ]) {
      const client = withEnv(HOSTILE, () => createClient({ url, ssl: 'disable' }));
      const password = (client as unknown as { password: unknown }).password;
      expect(typeof password).toBe('function');
      expect(await (password as () => Promise<string>)()).toBe(url.includes(':pw@') ? 'pw' : '');
    }
  });
});

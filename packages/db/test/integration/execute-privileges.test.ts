import { expect, it } from 'vitest';
import { migrate, shippedMigrations } from './support/cli.ts';
import { databases } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { query } from './support/sql.ts';

const dbs = databases();

// Functions are executable by PUBLIC unless the default is revoked, and every role, the
// reader included, is a member of PUBLIC.
describeWithStack('EXECUTE on functions in app', () => {
  // The user reader is for drefyn_app alone: the reader and the auth role never have a user.
  it('lets only the app and reader roles call the context readers', async () => {
    const db = await dbs.fresh('migrated');
    const rows = await query<{ fn: string; grantee: string }>(
      db.owner,
      `select 'app.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn,
              case when a.grantee = 0 then 'public' else pg_get_userbyid(a.grantee) end as grantee
         from pg_proc p cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where p.pronamespace = 'app'::regnamespace and a.grantee <> p.proowner
        order by 1, 2`,
    );
    expect(rows).toEqual([
      { fn: 'app.current_org()', grantee: 'drefyn_app' },
      { fn: 'app.current_org()', grantee: 'drefyn_public_reader' },
      { fn: 'app.current_project()', grantee: 'drefyn_app' },
      { fn: 'app.current_project()', grantee: 'drefyn_public_reader' },
      { fn: 'app.current_user_id()', grantee: 'drefyn_app' },
    ]);
  });

  it('gives a function the owner creates later to nobody else', async () => {
    const db = await dbs.fresh('migrated');
    await query(db.owner, 'create function app.later() returns int language sql as $$ select 1 $$');
    expect(
      await query(
        db.owner,
        `select has_function_privilege('drefyn_public_reader', 'app.later()', 'EXECUTE') as reader,
                exists (select from pg_proc p cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                         where p.oid = 'app.later()'::regprocedure and a.grantee = 0) as public`,
      ),
    ).toEqual([{ reader: false, public: false }]);
  });

  it('keeps the policies working for the app role', async () => {
    const db = await dbs.fresh('migrated');
    expect(
      await query(db.app, 'select app.current_org() as org, app.current_project() as project'),
    ).toEqual([{ org: null, project: null }]);
  });

  it('lets the reader call the tenant context readers', async () => {
    const db = await dbs.fresh('migrated');
    expect(
      await query(db.reader, 'select app.current_org() as org, app.current_project() as project'),
    ).toEqual([{ org: null, project: null }]);
  });

  it('gives the reader usage on schema app and nothing it could create with', async () => {
    const db = await dbs.fresh('migrated');
    expect(
      await query(
        db.owner,
        `select has_schema_privilege('drefyn_public_reader', 'app', 'USAGE') as usage,
                has_schema_privilege('drefyn_public_reader', 'app', 'CREATE') as create`,
      ),
    ).toEqual([{ usage: true, create: false }]);
  });

  it('reverses on down: the readers go back to the first migration grants', async () => {
    const db = await dbs.fresh('migrated');
    const files = shippedMigrations();
    expect(files.length).toBeGreaterThanOrEqual(2);
    const down = await migrate(['migrate', 'down', String(files.length - 1)], { url: db.owner });
    expect(down.code, down.stderr).toBe(0);
    expect(
      await query(
        db.owner,
        `select has_schema_privilege('drefyn_public_reader', 'app', 'USAGE') as reader_usage`,
      ),
    ).toEqual([{ reader_usage: false }]);
    const up = await migrate(['migrate', 'up'], { url: db.owner });
    expect(up.code, up.stderr).toBe(0);
  });
});

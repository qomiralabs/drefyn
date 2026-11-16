import { expect, it } from 'vitest';
import { ALLOW_LISTS } from '../../src/allow-lists.ts';
import { describeFailure, migrate, shippedMigrations } from './support/cli.ts';
import { databases, dropDatabase, newName, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { chunkSql, seed, seedTenant, seedTenantsSql } from './support/published-chunks.ts';
import { dumpInto, superuser } from './support/stack.ts';
import { catalogProblems } from './support/tenancy.ts';

const dbs = databases();

const TABLES = [
  'published_chunk_terms',
  'published_chunks',
  'published_project_term_totals',
  'published_term_stats',
];

const lines = (text: string) =>
  text
    .trim()
    .split('\n')
    .filter((line) => line !== '');

const columns = (db: TestDatabase, table: string) =>
  superuser(
    `select column_name || ' ' || data_type || ' ' || is_nullable || ' ' ||
            coalesce(column_default, '-') || ' ' || is_generated
       from information_schema.columns
      where table_schema = 'app' and table_name = '${table}' order by ordinal_position;`,
    db.name,
  ).then(lines);

const indexes = (db: TestDatabase) =>
  superuser(
    `select indexdef from pg_indexes where schemaname = 'app'
        and tablename in (${TABLES.map((t) => `'${t}'`).join(', ')}) order by indexname;`,
    db.name,
  ).then(lines);

const policies = (db: TestDatabase) =>
  superuser(
    `set search_path = pg_catalog;
     select tablename || ' ' || policyname || ' ' || permissive || ' ' || cmd || ' ' ||
            array_to_string(roles, '+') || ' ' || coalesce(qual, '-') || ' ' ||
            coalesce(with_check, '-')
       from pg_policies where schemaname = 'app'
        and tablename in (${TABLES.map((t) => `'${t}'`).join(', ')})
      order by tablename, policyname;`,
    db.name,
  ).then(lines);

const grants = (db: TestDatabase) =>
  superuser(
    `select grantee || ' ' || table_name || ' ' || privilege_type
       from information_schema.role_table_grants
      where table_schema = 'app' and table_name in (${TABLES.map((t) => `'${t}'`).join(', ')})
        and grantee in ('drefyn_public_reader', 'drefyn_app')
      order by grantee, table_name, privilege_type;`,
    db.name,
  ).then(lines);

const step = async (db: TestDatabase, args: readonly string[]) => {
  const result = await migrate(args, { url: db.owner });
  expect(result.code, describeFailure(result)).toBe(0);
};

function stepsBack(): number {
  const shipped = shippedMigrations();
  const at = shipped.findIndex((file) => file.endsWith('_published_chunks.sql'));
  expect(at).toBeGreaterThanOrEqual(0);
  return shipped.length - at;
}

const TENANT = seedTenant(61, 1);

describeWithStack('the published chunks migration', () => {
  it('creates published_chunks with every column the copy needs and a generated search column', async () => {
    const db = await dbs.fresh('migrated');
    expect(await columns(db, 'published_chunks')).toEqual([
      'id uuid NO uuidv7() NEVER',
      'organization_id uuid NO - NEVER',
      'project_id uuid NO - NEVER',
      'node_id uuid NO - NEVER',
      'version_id uuid NO - NEVER',
      'ord integer NO - NEVER',
      'page_path text NO - NEVER',
      'title text NO - NEVER',
      'heading_path ARRAY NO - NEVER',
      'body text NO - NEVER',
      'body_sha256 bytea NO - NEVER',
      'visibility text NO - NEVER',
      'is_current boolean NO - NEVER',
      'search tsvector YES - ALWAYS',
    ]);
    const generated = await superuser(
      `set search_path = pg_catalog;
       select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d
         join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
        where d.adrelid = 'app.published_chunks'::regclass and a.attname = 'search';`,
      db.name,
    );
    expect(generated.trim()).toBe(
      "to_tsvector('simple'::regconfig, ((app.heading_text(heading_path) || ' '::text) || body))",
    );
    const stored = await superuser(
      `select attgenerated from pg_attribute
        where attrelid = 'app.published_chunks'::regclass and attname = 'search';`,
      db.name,
    );
    expect(stored.trim()).toBe('s');
  });

  it('creates the three term tables keyed by version label', async () => {
    const db = await dbs.fresh('migrated');
    const label = "version_label text NO 'latest'::text NEVER";
    expect(await columns(db, 'published_project_term_totals')).toEqual([
      'organization_id uuid NO - NEVER',
      'project_id uuid NO - NEVER',
      label,
      'chunk_count integer NO - NEVER',
      'total_length bigint NO - NEVER',
    ]);
    expect(await columns(db, 'published_term_stats')).toEqual([
      'organization_id uuid NO - NEVER',
      'project_id uuid NO - NEVER',
      label,
      'lexeme text NO - NEVER',
      'df integer NO - NEVER',
    ]);
    expect(await columns(db, 'published_chunk_terms')).toEqual([
      'organization_id uuid NO - NEVER',
      'project_id uuid NO - NEVER',
      label,
      'lexeme text NO - NEVER',
      'chunk_id uuid NO - NEVER',
      'tf integer NO - NEVER',
      'chunk_length integer NO - NEVER',
    ]);
  });

  it('has the indexes retrieval and publish read, each led by the tenant columns', async () => {
    const db = await dbs.fresh('migrated');
    expect(await indexes(db)).toEqual([
      'CREATE INDEX published_chunk_terms_chunk ON app.published_chunk_terms USING btree (organization_id, project_id, chunk_id)',
      'CREATE INDEX published_chunk_terms_impact ON app.published_chunk_terms USING btree (organization_id, project_id, version_label, lexeme, tf DESC, chunk_id)',
      'CREATE UNIQUE INDEX published_chunk_terms_pkey ON app.published_chunk_terms USING btree (organization_id, project_id, version_label, lexeme, chunk_id)',
      'CREATE INDEX published_chunks_current ON app.published_chunks USING btree (organization_id, project_id, page_path, ord) WHERE is_current',
      'CREATE INDEX published_chunks_hash ON app.published_chunks USING btree (organization_id, project_id, body_sha256)',
      'CREATE INDEX published_chunks_node ON app.published_chunks USING btree (organization_id, project_id, node_id) WHERE is_current',
      'CREATE UNIQUE INDEX published_chunks_pkey ON app.published_chunks USING btree (id)',
      'CREATE UNIQUE INDEX published_chunks_tenant_id_key ON app.published_chunks USING btree (organization_id, project_id, id)',
      'CREATE UNIQUE INDEX published_chunks_version_ord_key ON app.published_chunks USING btree (organization_id, project_id, version_id, ord)',
      'CREATE UNIQUE INDEX published_project_term_totals_pkey ON app.published_project_term_totals USING btree (organization_id, project_id, version_label)',
      'CREATE UNIQUE INDEX published_term_stats_pkey ON app.published_term_stats USING btree (organization_id, project_id, version_label, lexeme)',
    ]);
    const keys = await superuser(
      `set search_path = pg_catalog;
       select conrelid::regclass::text || ' ' || pg_get_constraintdef(oid) from pg_constraint
        where contype = 'f' and conrelid in ('app.published_chunks'::regclass,
              'app.published_chunk_terms'::regclass) order by conname;`,
      db.name,
    );
    expect(lines(keys)).toEqual([
      'app.published_chunk_terms FOREIGN KEY (organization_id, project_id, chunk_id) REFERENCES app.published_chunks(organization_id, project_id, id) ON DELETE CASCADE',
      'app.published_chunks FOREIGN KEY (organization_id, project_id) REFERENCES app.projects(organization_id, id)',
      'app.published_chunks FOREIGN KEY (organization_id, project_id, node_id, version_id) REFERENCES app.published_versions(organization_id, project_id, node_id, version_id) ON DELETE CASCADE',
    ]);
  });

  it('forces RLS, grants the reader select only, and keeps protected chunks behind a restrictive policy', async () => {
    const db = await dbs.fresh('migrated');
    const forced = await superuser(
      `select relname || ' ' || relrowsecurity || ' ' || relforcerowsecurity from pg_class
        where relnamespace = 'app'::regnamespace
          and relname in (${TABLES.map((t) => `'${t}'`).join(', ')}) order by relname;`,
      db.name,
    );
    expect(lines(forced)).toEqual(TABLES.map((t) => `${t} true true`));
    const tenant =
      '((organization_id = app.current_org()) AND (project_id = app.current_project()))';
    const standard = (table: string) => [
      `${table} published_read PERMISSIVE SELECT drefyn_public_reader ${tenant} -`,
      `${table} tenant_isolation PERMISSIVE ALL drefyn_app ${tenant} ${tenant}`,
    ];
    expect(await policies(db)).toEqual([
      ...standard('published_chunk_terms'),
      `published_chunks published_public_only RESTRICTIVE SELECT drefyn_public_reader (visibility = 'public'::text) -`,
      ...standard('published_chunks'),
      ...standard('published_project_term_totals'),
      ...standard('published_term_stats'),
    ]);
    expect(await grants(db)).toEqual([
      ...TABLES.flatMap((t) =>
        ['DELETE', 'INSERT', 'SELECT', 'UPDATE'].map((p) => `drefyn_app ${t} ${p}`),
      ),
      ...TABLES.map((t) => `drefyn_public_reader ${t} SELECT`),
    ]);
    expect(await catalogProblems(db.owner, ALLOW_LISTS)).toEqual([]);
  });

  it('declares heading_text immutable, strict and parallel safe, runnable by the app role only', async () => {
    const db = await dbs.fresh('migrated');
    const facts = await superuser(
      `select provolatile::text || ' ' || proisstrict || ' ' || proparallel::text || ' ' || prosecdef || ' ' ||
              pg_get_function_result(oid)
         from pg_proc where oid = 'app.heading_text(text[])'::regprocedure;`,
      db.name,
    );
    expect(facts.trim()).toBe('i true s false text');
    const runners = await superuser(
      `select r.rolname from pg_roles r
        where has_function_privilege(r.oid, 'app.heading_text(text[])', 'execute')
          and r.rolname like 'drefyn%' and not r.rolsuper order by 1;`,
      db.name,
    );
    expect(lines(runners)).toEqual(['drefyn_app', 'drefyn_owner']);
  });

  it('builds the search column on the pinned image and reproduces it byte for byte after a dump and restore', async () => {
    const db = await dbs.fresh('migrated');
    await seed(
      db.name,
      [
        seedTenantsSql([TENANT]),
        chunkSql(TENANT, {
          ord: 0,
          headingPath: ['Install', 'With pnpm'],
          body: 'Run pnpm add drefyn, then pnpm add drefyn again.',
          visibility: 'public',
        }),
        chunkSql(TENANT, {
          ord: 1,
          headingPath: [],
          body: "Quotes ' and backslashes \\ and accents: café, naïve. 42 x-y",
          visibility: 'protected',
        }),
        chunkSql(TENANT, { ord: 2, headingPath: ['Only heading'], body: '', visibility: 'public' }),
      ].join('\n'),
    );
    const vectors = (name: string) =>
      superuser(
        `select ord || ' ' || search::text from app.published_chunks order by ord;`,
        name,
      ).then(lines);
    const before = await vectors(db.name);
    expect(before).toEqual([
      "0 'add':6,10 'again':12 'drefyn':7,11 'install':1 'pnpm':3,5,9 'run':4 'then':8 'with':2",
      expect.stringMatching(/^1 /),
      "2 'heading':2 'only':1",
    ]);
    const target = newName('r');
    dbs.created.push(target);
    await superuser(`create database ${target} template template0;`);
    try {
      await dumpInto(db.name, target);
      expect(await vectors(target)).toEqual(before);
    } finally {
      await dropDatabase(target);
    }
  });

  it('refuses a chunk whose version is not published, and drops chunks and postings with their version', async () => {
    const db = await dbs.fresh('migrated');
    await seed(db.name, seedTenantsSql([TENANT]));
    await expect(
      superuser(
        chunkSql(
          { ...TENANT, version: '01a14984-4476-77ce-9335-990000000000' },
          { ord: 0, headingPath: [], body: 'x', visibility: 'public' },
        ),
        db.name,
      ),
    ).rejects.toThrow(/published_chunks_version_fkey/);
    await seed(
      db.name,
      `${chunkSql(TENANT, { ord: 0, headingPath: [], body: 'one two', visibility: 'public' })}
insert into app.published_chunk_terms (organization_id, project_id, lexeme, chunk_id, tf, chunk_length)
  select organization_id, project_id, 'one', id, 1, 2 from app.published_chunks;
delete from app.published_versions;`,
    );
    const left = await superuser(
      `select (select count(*) from app.published_chunks) || ' ' ||
              (select count(*) from app.published_chunk_terms);`,
      db.name,
    );
    expect(left.trim()).toBe('0 0');
  });

  it('refuses a zero document frequency, a protected visibility typo and a missing visibility', async () => {
    const db = await dbs.fresh('migrated');
    await seed(db.name, seedTenantsSql([TENANT]));
    await expect(
      superuser(
        `insert into app.published_term_stats (organization_id, project_id, lexeme, df)
           values ('${TENANT.org}', '${TENANT.project}', 'x', 0);`,
        db.name,
      ),
    ).rejects.toThrow(/published_term_stats_df_check/);
    await expect(
      superuser(
        chunkSql(TENANT, {
          ord: 0,
          headingPath: [],
          body: 'x',
          visibility: 'Public' as 'public',
        }),
        db.name,
      ),
    ).rejects.toThrow(/published_chunks_visibility_check/);
    await expect(
      superuser(
        `insert into app.published_chunks (organization_id, project_id, node_id, version_id, ord,
            page_path, title, heading_path, body, body_sha256, is_current)
           values ('${TENANT.org}', '${TENANT.project}', '${TENANT.node}', '${TENANT.version}', 0,
             '/p', 'P', '{}', 'x', sha256('x'::bytea), true);`,
        db.name,
      ),
    ).rejects.toThrow(/visibility/);
  });

  it('reverts cleanly and applies again', async () => {
    const db = await dbs.fresh('migrated');
    await step(db, ['migrate', 'down', String(stepsBack())]);
    const left = await superuser(
      `select (select count(*) from pg_tables where schemaname = 'app'
                 and tablename in (${TABLES.map((t) => `'${t}'`).join(', ')})) || ' ' ||
              (select count(*) from pg_proc where proname = 'heading_text');`,
      db.name,
    );
    expect(left.trim()).toBe('0 0');
    expect(await grants(db)).toEqual([]);
    await step(db, ['migrate', 'up']);
    expect(await grants(db)).toHaveLength(TABLES.length * 5);
    expect(await catalogProblems(db.owner, ALLOW_LISTS)).toEqual([]);
  });
});

import { beforeAll, describe, expect, it } from 'vitest';
import { ALLOW_LISTS, type AllowLists } from '../../src/allow-lists.ts';
import type { CatalogProblem, CatalogRule } from '../../src/catalog-check.ts';
import { tenantTableSql } from '../../src/tenant-sql.ts';
import { describeFailure, fixtureMigrations, migrate, migration } from './support/cli.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { run } from './support/process.ts';
import { query } from './support/sql.ts';
import { packageRoot } from './support/stack.ts';
import {
  FIXTURE_ALLOW_LISTS,
  FIXTURE_DOWN,
  FIXTURE_FILE,
  catalogProblems,
  fixtureSchemaUp,
  fixtureTemplate,
} from './support/tenancy.ts';

const dbs = databases();
const fixture = fixtureTemplate(dbs);

const BAD_FILE = '9000000000002_bad.sql';

// A valid organization scoped table from the helper, for cases that break one thing on it.
const orgTable = (name: string, columns: readonly string[] = ['body text']) =>
  tenantTableSql({ name, scope: 'organization', columns });

const projectTable = (name: string, columns: readonly string[] = ['body text']) =>
  tenantTableSql({ name, scope: 'project', columns, projectsTable: 'fixture_projects' });

// A table with no organization_id, for the identity table rules. RLS is on, as the real ones
// will have it.
const globalTable = (name: string, columns: readonly string[] = ['body text']) =>
  `create table app.${name} (id uuid primary key default uuidv7(), ${columns.join(', ')});
alter table app.${name} enable row level security;
alter table app.${name} force row level security;`;

const reviewed = (name: string) => ({ name, reason: 'test only' });

// The fixture lists with the given global tables, and anything else the case needs.
function lists(globals: readonly string[], more: Partial<AllowLists> = {}): AllowLists {
  return {
    ...FIXTURE_ALLOW_LISTS,
    globalTables: [
      ...FIXTURE_ALLOW_LISTS.globalTables,
      ...globals.map((g) => reviewed(`app.${g}`)),
    ],
    ...more,
  };
}

const SELF = '(id = app.current_user_id())';

interface BadCase {
  readonly rule: CatalogRule;
  readonly object: string;
  // Text every message for this case must contain, besides the object.
  readonly mentions?: readonly string[];
  readonly up: () => string;
  readonly allow?: AllowLists;
}

const CASES: Record<string, BadCase> = {
  'a table without organization_id': {
    rule: 'tenant_column',
    object: 'app.bad_no_org',
    mentions: ['organization_id'],
    up: () => `create table app.bad_no_org (id uuid primary key default uuidv7(), body text);
alter table app.bad_no_org enable row level security;
alter table app.bad_no_org force row level security;
create policy deny on app.bad_no_org using (false);`,
  },
  'a nullable organization_id': {
    rule: 'tenant_column',
    object: 'app.bad_null_org',
    up: () => `${orgTable('bad_null_org')}
alter table app.bad_null_org alter column organization_id drop not null;`,
  },
  'an organization_id that is not a uuid': {
    rule: 'tenant_column',
    object: 'app.bad_text_org',
    up: () => `create table app.bad_text_org (id uuid primary key default uuidv7(), organization_id text not null);
alter table app.bad_text_org enable row level security;
alter table app.bad_text_org force row level security;
create policy tenant_isolation on app.bad_text_org
  using (organization_id = app.current_org()::text) with check (organization_id = app.current_org()::text);`,
  },
  'a nullable project_id': {
    rule: 'tenant_column',
    object: 'app.bad_null_project',
    up: () => `${projectTable('bad_null_project')}
alter table app.bad_null_project alter column project_id drop not null;`,
  },
  'row level security not enabled': {
    rule: 'rls_enabled',
    object: 'app.bad_no_rls',
    up: () => `${orgTable('bad_no_rls')}
alter table app.bad_no_rls disable row level security;`,
  },
  'row level security not forced': {
    rule: 'rls_forced',
    object: 'app.bad_not_forced',
    up: () => `${orgTable('bad_not_forced')}
alter table app.bad_not_forced no force row level security;`,
  },
  'no policy': {
    rule: 'policy',
    object: 'app.bad_no_policy',
    up: () => `${orgTable('bad_no_policy')}
drop policy tenant_isolation on app.bad_no_policy;`,
  },
  // Permissive policies are OR'd, so one open policy undoes tenant_isolation.
  'an extra open policy': {
    rule: 'policy',
    object: 'app.bad_open_policy',
    up: () => `${orgTable('bad_open_policy')}
create policy everyone on app.bad_open_policy using (true) with check (true);`,
  },
  'a weakened tenant_isolation': {
    rule: 'policy',
    object: 'app.bad_weak_policy',
    up: () => `${orgTable('bad_weak_policy')}
alter policy tenant_isolation on app.bad_weak_policy
  using (organization_id = app.current_org() or true) with check (true);`,
  },
  // tenant_isolation is to drefyn_app: on PUBLIC it would widen the reader and the owner.
  'a tenant_isolation for every role': {
    rule: 'policy',
    object: 'app.bad_policy_roles',
    mentions: ['drefyn_app'],
    up: () => `${orgTable('bad_policy_roles')}
drop policy tenant_isolation on app.bad_policy_roles;
create policy tenant_isolation on app.bad_policy_roles
  using (organization_id = app.current_org()) with check (organization_id = app.current_org());`,
  },
  'a tenant_isolation for the reader too': {
    rule: 'policy',
    object: 'app.bad_policy_reader',
    up: () => `${orgTable('bad_policy_reader')}
alter policy tenant_isolation on app.bad_policy_reader to drefyn_app, drefyn_public_reader;`,
  },
  // published_read is the one extra permissive policy, and only on allow listed tables.
  'a published_read on a table off the published list': {
    rule: 'policy',
    object: 'app.bad_published_read',
    up: () => `${projectTable('bad_published_read')}
create policy published_read on app.bad_published_read for select to drefyn_public_reader
  using (organization_id = app.current_org() and project_id = app.current_project());`,
  },
  'a published_read for every role': {
    rule: 'policy',
    object: 'app.fixture_published',
    up: () => `alter policy published_read on app.fixture_published to public;`,
  },
  'a published_read without the project clause': {
    rule: 'policy',
    object: 'app.fixture_published',
    up: () => `alter policy published_read on app.fixture_published
  using (organization_id = app.current_org());`,
  },
  'a project table with the project clause dropped': {
    rule: 'policy',
    object: 'app.bad_project_clause',
    up: () => `${projectTable('bad_project_clause')}
alter policy tenant_isolation on app.bad_project_clause
  using (organization_id = app.current_org()) with check (organization_id = app.current_org());`,
  },
  // The old project clause let organization scope read every project.
  'a project table with the old organization scope arm': {
    rule: 'policy',
    object: 'app.bad_null_arm',
    up: () => `${projectTable('bad_null_arm')}
alter policy tenant_isolation on app.bad_null_arm
  using (organization_id = app.current_org() and (app.current_project() is null or project_id = app.current_project()))
  with check (organization_id = app.current_org() and (app.current_project() is null or project_id = app.current_project()));`,
  },
  // Each half of the policy is compared on its own: an exact USING with an open WITH CHECK
  // would let drefyn_app write rows into another organization.
  'a tenant_isolation weakened only in with check': {
    rule: 'policy',
    object: 'app.bad_check_only',
    up: () => `${orgTable('bad_check_only')}
alter policy tenant_isolation on app.bad_check_only with check (true);`,
  },
  'a tenant_isolation weakened only in using': {
    rule: 'policy',
    object: 'app.bad_using_only',
    up: () => `${orgTable('bad_using_only')}
alter policy tenant_isolation on app.bad_using_only using (true);`,
  },
  'a tenant_isolation for select only': {
    rule: 'policy',
    object: 'app.bad_policy_cmd',
    up: () => `${orgTable('bad_policy_cmd')}
drop policy tenant_isolation on app.bad_policy_cmd;
create policy tenant_isolation on app.bad_policy_cmd for select to drefyn_app
  using (organization_id = app.current_org());`,
  },
  'a published_read for every command': {
    rule: 'policy',
    object: 'app.fixture_published',
    up: () => `drop policy published_read on app.fixture_published;
create policy published_read on app.fixture_published for all to drefyn_public_reader
  using (organization_id = app.current_org() and project_id = app.current_project());`,
  },
  // TRUNCATE ignores row level security.
  'a truncate grant to drefyn_app': {
    rule: 'app_privilege',
    object: 'app.fixture_notes',
    mentions: ['TRUNCATE', 'drefyn_app'],
    up: () => 'grant truncate on app.fixture_notes to drefyn_app;',
  },
  'all privileges to drefyn_app': {
    rule: 'app_privilege',
    object: 'app.fixture_drafts',
    mentions: ['REFERENCES'],
    up: () => 'grant all on app.fixture_drafts to drefyn_app;',
  },
  'a grant option for drefyn_app': {
    rule: 'app_privilege',
    object: 'app.fixture_members',
    mentions: ['grant option'],
    up: () => 'grant select on app.fixture_members to drefyn_app with grant option;',
  },
  'create on schema app for drefyn_app': {
    rule: 'app_privilege',
    object: 'app',
    mentions: ['CREATE'],
    up: () => 'grant create on schema app to drefyn_app;',
  },
  'an update grant on a sequence to drefyn_app': {
    rule: 'app_privilege',
    object: 'app.bad_app_seq',
    mentions: ['UPDATE'],
    up: () => `create sequence app.bad_app_seq;
grant update on sequence app.bad_app_seq to drefyn_app;`,
  },
  'execute on a function off the app allow list': {
    rule: 'app_privilege',
    object: 'app.bad_app_fn()',
    up: () => `create function app.bad_app_fn() returns int language sql as $$ select 1 $$;
grant execute on function app.bad_app_fn() to drefyn_app;`,
  },
  'default truncate for drefyn_app in schema app': {
    rule: 'app_privilege',
    object: 'drefyn_app',
    mentions: ['TRUNCATE'],
    up: () =>
      'alter default privileges for role drefyn_owner in schema app grant truncate on tables to drefyn_app;',
  },
  'default execute for drefyn_app everywhere': {
    rule: 'app_privilege',
    object: 'drefyn_app',
    mentions: ['EXECUTE'],
    up: () =>
      'alter default privileges for role drefyn_owner grant execute on functions to drefyn_app;',
  },
  // Referential checks ignore RLS, so a bare id would let one tenant probe another's rows.
  'a single column foreign key into a tenant table': {
    rule: 'tenant_foreign_key',
    object: 'app.bad_fk',
    mentions: ['organization_id'],
    up: () => orgTable('bad_fk', ['note_id uuid references app.fixture_notes (id)']),
  },
  'a foreign key between project tables without project_id': {
    rule: 'tenant_foreign_key',
    object: 'app.bad_fk_project',
    mentions: ['project_id'],
    up: () => `alter table app.fixture_notes add constraint fixture_notes_org_id_key unique (organization_id, id);
${projectTable('bad_fk_project', ['note_id uuid'])}
alter table app.bad_fk_project add foreign key (organization_id, note_id)
  references app.fixture_notes (organization_id, id);`,
  },
  'a numeric column': {
    rule: 'banned_type',
    object: 'app.bad_numeric.amount',
    mentions: ['numeric'],
    up: () => orgTable('bad_numeric', ['amount numeric(12, 2)']),
  },
  'a real column': {
    rule: 'banned_type',
    object: 'app.bad_real.ratio',
    mentions: ['real'],
    up: () => orgTable('bad_real', ['ratio real']),
  },
  'a double precision column': {
    rule: 'banned_type',
    object: 'app.bad_double.ratio',
    mentions: ['double precision'],
    up: () => orgTable('bad_double', ['ratio double precision']),
  },
  'a money column': {
    rule: 'banned_type',
    object: 'app.bad_money.amount',
    mentions: ['money'],
    up: () => orgTable('bad_money', ['amount money']),
  },
  'a timestamp without time zone column': {
    rule: 'banned_type',
    object: 'app.bad_timestamp.seen_at',
    mentions: ['timestamp without time zone'],
    up: () => orgTable('bad_timestamp', ['seen_at timestamp']),
  },
  'a numeric array column': {
    rule: 'banned_type',
    object: 'app.bad_array.amounts',
    mentions: ['numeric'],
    up: () => orgTable('bad_array', ['amounts numeric[]']),
  },
  'a domain over numeric': {
    rule: 'banned_type',
    object: 'app.bad_domain.amount',
    mentions: ['numeric'],
    up: () => `create domain app.bad_amount as numeric check (value >= 0);
${orgTable('bad_domain', ['amount app.bad_amount'])}`,
  },
  'a banned type on a global table': {
    rule: 'banned_type',
    object: 'app.pgmigrations.legacy_at',
    up: () => 'alter table app.pgmigrations add column legacy_at timestamp;',
  },
  'a security definer function': {
    rule: 'security_definer',
    object: 'app.bad_definer()',
    up: () => `create function app.bad_definer() returns int language sql security definer as $$ select 1 $$;
revoke execute on function app.bad_definer() from public;`,
  },
  'a view without security_invoker': {
    rule: 'view_security_invoker',
    object: 'app.bad_view',
    up: () => 'create view app.bad_view as select id, organization_id from app.fixture_notes;',
  },
  'a view with security_invoker false': {
    rule: 'view_security_invoker',
    object: 'app.bad_view_false',
    up: () =>
      'create view app.bad_view_false with (security_invoker = false) as select id from app.fixture_notes;',
  },
  // A materialized view stores rows with no row level security on them.
  'a materialized view': {
    rule: 'materialized_view',
    object: 'app.bad_matview',
    up: () =>
      'create materialized view app.bad_matview as select id, organization_id from app.fixture_notes;',
  },
  'a unique constraint without organization_id': {
    rule: 'tenant_unique',
    object: 'app.bad_unique',
    up: () =>
      tenantTableSql({
        name: 'bad_unique',
        scope: 'organization',
        columns: ['slug text'],
        constraints: ['unique (slug)'],
      }),
  },
  'a unique index without organization_id': {
    rule: 'tenant_unique',
    object: 'app.bad_unique_index',
    up: () => `${orgTable('bad_unique_index', ['slug text'])}
create unique index bad_unique_index_slug_key on app.bad_unique_index (slug);`,
  },
  'a partial unique index without organization_id': {
    rule: 'tenant_unique',
    object: 'app.bad_partial_unique',
    up: () => `${orgTable('bad_partial_unique', ['slug text'])}
create unique index bad_partial_unique_slug_key on app.bad_partial_unique (slug) where slug is not null;`,
  },
  'a reader grant on a tenant table': {
    rule: 'reader_grant',
    object: 'app.fixture_notes',
    mentions: ['drefyn_public_reader'],
    up: () => 'grant select on app.fixture_notes to drefyn_public_reader;',
  },
  'a column grant to the reader on a draft table': {
    rule: 'reader_grant',
    object: 'app.fixture_drafts',
    mentions: ['drefyn_public_reader', 'body'],
    up: () => 'grant select (body) on app.fixture_drafts to drefyn_public_reader;',
  },
  'a public grant the reader inherits': {
    rule: 'reader_grant',
    object: 'app.fixture_drafts',
    mentions: ['public'],
    up: () => 'grant select on app.fixture_drafts to public;',
  },
  'a write grant to the reader on a published table': {
    rule: 'reader_grant',
    object: 'app.fixture_published',
    mentions: ['drefyn_public_reader', 'INSERT'],
    up: () => 'grant insert on app.fixture_published to drefyn_public_reader;',
  },
  'a reader grant on a sequence': {
    rule: 'reader_grant',
    object: 'app.bad_seq',
    mentions: ['drefyn_public_reader'],
    up: () => `create sequence app.bad_seq;
grant usage on sequence app.bad_seq to drefyn_public_reader;`,
  },
  'a reader grant on a function': {
    rule: 'reader_grant',
    object: 'app.bad_reader_fn()',
    mentions: ['drefyn_public_reader'],
    up: () => `create function app.bad_reader_fn() returns int language sql as $$ select 1 $$;
revoke execute on function app.bad_reader_fn() from public;
grant execute on function app.bad_reader_fn() to drefyn_public_reader;`,
  },
  'a function anyone can execute': {
    rule: 'public_execute',
    object: 'app.bad_public_fn()',
    up: () => `create function app.bad_public_fn() returns int language sql as $$ select 1 $$;
grant execute on function app.bad_public_fn() to public;`,
  },
  'default privileges for the reader': {
    rule: 'default_privileges',
    object: 'drefyn_public_reader',
    up: () =>
      'alter default privileges for role drefyn_owner in schema app grant select on tables to drefyn_public_reader;',
  },
  'default execute for public put back': {
    rule: 'default_privileges',
    object: 'public',
    up: () =>
      'alter default privileges for role drefyn_owner grant execute on functions to public;',
  },
  // The sign in role must never reach tenant data, whatever the auth table list says.
  'an auth grant on an organization table': {
    rule: 'auth_grant',
    object: 'app.fixture_members',
    mentions: ['drefyn_auth', 'organization_id'],
    up: () => 'grant select on app.fixture_members to drefyn_auth;',
  },
  'an auth grant on an organization table on the auth list': {
    rule: 'auth_grant',
    object: 'app.fixture_members',
    mentions: ['organization_id'],
    up: () => 'grant select on app.fixture_members to drefyn_auth;',
    allow: lists([], { authTables: [reviewed('app.fixture_members')] }),
  },
  'an auth grant on a project table': {
    rule: 'auth_grant',
    object: 'app.fixture_published',
    up: () => 'grant select on app.fixture_published to drefyn_auth;',
  },
  'an auth grant on a global table off the auth list': {
    rule: 'auth_grant',
    object: 'app.bad_auth_global',
    mentions: ['drefyn_auth', 'auth table allow list'],
    up: () => `${globalTable('bad_auth_global')}
grant select on app.bad_auth_global to drefyn_auth;`,
    allow: lists(['bad_auth_global']),
  },
  'a column grant to drefyn_auth on a tenant table': {
    rule: 'auth_grant',
    object: 'app.fixture_members',
    mentions: ['email'],
    up: () => 'grant select (email) on app.fixture_members to drefyn_auth;',
  },
  'execute on a context reader for drefyn_auth': {
    rule: 'auth_grant',
    object: 'app.current_org()',
    up: () => 'grant execute on function app.current_org() to drefyn_auth;',
  },
  'create on schema app for drefyn_auth': {
    rule: 'auth_grant',
    object: 'app',
    mentions: ['CREATE'],
    up: () => 'grant create on schema app to drefyn_auth;',
  },
  'default privileges for drefyn_auth': {
    rule: 'default_privileges',
    object: 'drefyn_auth',
    up: () =>
      'alter default privileges for role drefyn_owner in schema app grant select on tables to drefyn_auth;',
  },
  // A global table had no policy rule at all: a user keyed policy must be reviewed.
  'a user policy off the allow list': {
    rule: 'policy',
    object: 'app.bad_user_policy',
    mentions: ['self_read'],
    up: () => `${globalTable('bad_user_policy')}
create policy self_read on app.bad_user_policy for select to drefyn_app
  using (id = app.current_user_id());`,
    allow: lists(['bad_user_policy']),
  },
  'a user policy that differs from its entry': {
    rule: 'policy',
    object: 'app.bad_policy_text',
    mentions: ['self_read', 'USING'],
    up: () => `${globalTable('bad_policy_text')}
create policy self_read on app.bad_policy_text for select to drefyn_app using (true);`,
    allow: lists(['bad_policy_text'], {
      userPolicies: [
        {
          name: 'app.bad_policy_text.self_read',
          command: 'select',
          roles: ['drefyn_app'],
          using: SELF,
          withCheck: null,
          reason: 'test only',
        },
      ],
    }),
  },
  'a user policy for another command than its entry': {
    rule: 'policy',
    object: 'app.bad_policy_cmd_user',
    mentions: ['self_read'],
    up: () => `${globalTable('bad_policy_cmd_user')}
create policy self_read on app.bad_policy_cmd_user to drefyn_app
  using (id = app.current_user_id()) with check (id = app.current_user_id());`,
    allow: lists(['bad_policy_cmd_user'], {
      userPolicies: [
        {
          name: 'app.bad_policy_cmd_user.self_read',
          command: 'select',
          roles: ['drefyn_app'],
          using: SELF,
          withCheck: null,
          reason: 'test only',
        },
      ],
    }),
  },
  // Each of the next three differs from its entry in one field only, so every comparison is
  // needed to catch it.
  'a user policy whose command alone differs from its entry': {
    rule: 'policy',
    object: 'app.bad_policy_only_cmd',
    mentions: ['self_read', 'is for delete, not select'],
    up: () => `${globalTable('bad_policy_only_cmd')}
create policy self_read on app.bad_policy_only_cmd for delete to drefyn_app
  using (id = app.current_user_id());`,
    allow: lists(['bad_policy_only_cmd'], {
      userPolicies: [
        {
          name: 'app.bad_policy_only_cmd.self_read',
          command: 'select',
          roles: ['drefyn_app'],
          using: SELF,
          withCheck: null,
          reason: 'test only',
        },
      ],
    }),
  },
  'a user policy whose roles alone differ from its entry': {
    rule: 'policy',
    object: 'app.bad_policy_only_roles',
    mentions: ['self_read', 'is to drefyn_app, drefyn_auth, not drefyn_app'],
    up: () => `${globalTable('bad_policy_only_roles')}
create policy self_read on app.bad_policy_only_roles for select to drefyn_app, drefyn_auth
  using (id = app.current_user_id());`,
    allow: lists(['bad_policy_only_roles'], {
      userPolicies: [
        {
          name: 'app.bad_policy_only_roles.self_read',
          command: 'select',
          roles: ['drefyn_app'],
          using: SELF,
          withCheck: null,
          reason: 'test only',
        },
      ],
    }),
  },
  'a user policy whose WITH CHECK alone differs from its entry': {
    rule: 'policy',
    object: 'app.bad_policy_only_check',
    mentions: ['self_update', 'WITH CHECK'],
    up: () => `${globalTable('bad_policy_only_check')}
create policy self_update on app.bad_policy_only_check for update to drefyn_app
  using (id = app.current_user_id()) with check (true);`,
    allow: lists(['bad_policy_only_check'], {
      userPolicies: [
        {
          name: 'app.bad_policy_only_check.self_update',
          command: 'update',
          roles: ['drefyn_app'],
          using: SELF,
          withCheck: SELF,
          reason: 'test only',
        },
      ],
    }),
  },
  // drefyn_auth is held to plain DML on a listed table: TRUNCATE ignores RLS, and the rest is
  // owner business.
  'a truncate grant to drefyn_auth on a listed auth table': {
    rule: 'auth_grant',
    object: 'app.bad_auth_truncate',
    mentions: ['TRUNCATE', 'drefyn_auth'],
    up: () => `${globalTable('bad_auth_truncate')}
revoke all on app.bad_auth_truncate from drefyn_app;
grant truncate on app.bad_auth_truncate to drefyn_auth;`,
    allow: lists(['bad_auth_truncate'], { authTables: [reviewed('app.bad_auth_truncate')] }),
  },
  'a trigger grant to drefyn_auth on a listed auth table': {
    rule: 'auth_grant',
    object: 'app.bad_auth_trigger',
    mentions: ['TRIGGER'],
    up: () => `${globalTable('bad_auth_trigger')}
revoke all on app.bad_auth_trigger from drefyn_app;
grant trigger on app.bad_auth_trigger to drefyn_auth;`,
    allow: lists(['bad_auth_trigger'], { authTables: [reviewed('app.bad_auth_trigger')] }),
  },
  'a references grant to drefyn_auth on a listed auth table': {
    rule: 'auth_grant',
    object: 'app.bad_auth_references',
    mentions: ['REFERENCES'],
    up: () => `${globalTable('bad_auth_references')}
revoke all on app.bad_auth_references from drefyn_app;
grant references on app.bad_auth_references to drefyn_auth;`,
    allow: lists(['bad_auth_references'], { authTables: [reviewed('app.bad_auth_references')] }),
  },
  'a grant option for drefyn_auth on a listed auth table': {
    rule: 'auth_grant',
    object: 'app.bad_auth_option',
    mentions: ['SELECT', 'grant option'],
    up: () => `${globalTable('bad_auth_option')}
revoke all on app.bad_auth_option from drefyn_app;
grant select on app.bad_auth_option to drefyn_auth with grant option;`,
    allow: lists(['bad_auth_option'], { authTables: [reviewed('app.bad_auth_option')] }),
  },
  'a column grant option for drefyn_auth on a listed auth table': {
    rule: 'auth_grant',
    object: 'app.bad_auth_column_option',
    mentions: ['app.bad_auth_column_option.body', 'grant option'],
    up: () => `${globalTable('bad_auth_column_option')}
revoke all on app.bad_auth_column_option from drefyn_app;
grant select (body) on app.bad_auth_column_option to drefyn_auth with grant option;`,
    allow: lists(['bad_auth_column_option'], {
      authTables: [reviewed('app.bad_auth_column_option')],
    }),
  },
  // The shipped users and password_credentials tables carry column grants only; each case
  // adds one grant on top of them.
  'a table level select on users for drefyn_app': {
    rule: 'column_grant',
    object: 'app.users',
    mentions: ['SELECT', 'drefyn_app'],
    up: () => 'grant select on app.users to drefyn_app;',
  },
  'a table level update on users': {
    rule: 'column_grant',
    object: 'app.users',
    mentions: ['UPDATE'],
    up: () => 'grant update on app.users to drefyn_app;',
  },
  'a table level insert on users': {
    rule: 'column_grant',
    object: 'app.users',
    mentions: ['INSERT', 'drefyn_auth'],
    up: () => 'grant insert on app.users to drefyn_auth;',
  },
  'a column grant off the list on users': {
    rule: 'column_grant',
    object: 'app.users',
    mentions: ['app.users.email', 'UPDATE', 'drefyn_app'],
    up: () => 'grant update (email) on app.users to drefyn_app;',
  },
  'a column insert off the list on users': {
    rule: 'column_grant',
    object: 'app.users',
    mentions: ['app.users.created_at', 'INSERT', 'drefyn_auth'],
    up: () => 'grant insert (created_at) on app.users to drefyn_auth;',
  },
  'a column grant off the list on password_credentials': {
    rule: 'column_grant',
    object: 'app.password_credentials',
    mentions: ['app.password_credentials.created_at', 'drefyn_auth'],
    up: () => 'grant select (created_at) on app.password_credentials to drefyn_auth;',
  },
  'a table level update on password_credentials for drefyn_auth': {
    rule: 'column_grant',
    object: 'app.password_credentials',
    mentions: ['UPDATE'],
    up: () => 'grant update on app.password_credentials to drefyn_auth;',
  },
  'a table level insert on password_credentials for drefyn_app': {
    rule: 'column_grant',
    object: 'app.password_credentials',
    mentions: ['INSERT', 'drefyn_app'],
    up: () => 'grant insert on app.password_credentials to drefyn_app;',
  },
  // The auth only tables hold addresses of people who never signed up, codes and limiter
  // keys; drefyn_app runs every request, so it holds nothing there.
  'a grant to drefyn_app on email_challenges': {
    rule: 'auth_only',
    object: 'app.email_challenges',
    mentions: ['SELECT', 'drefyn_app'],
    up: () => 'grant select on app.email_challenges to drefyn_app;',
  },
  'a grant to drefyn_app on oauth_states': {
    rule: 'auth_only',
    object: 'app.oauth_states',
    mentions: ['DELETE', 'drefyn_app'],
    up: () => 'grant delete on app.oauth_states to drefyn_app;',
  },
  'a grant to drefyn_app on auth_rate_limits': {
    rule: 'auth_only',
    object: 'app.auth_rate_limits',
    mentions: ['INSERT', 'drefyn_app'],
    up: () => 'grant insert on app.auth_rate_limits to drefyn_app;',
  },
  'a column grant to drefyn_app on auth_rate_limits': {
    rule: 'auth_only',
    object: 'app.auth_rate_limits',
    mentions: ['app.auth_rate_limits.bucket', 'drefyn_app'],
    up: () => 'grant select (bucket) on app.auth_rate_limits to drefyn_app;',
  },
  // The API service never holds the auth role, and the sign in role never reaches the API
  // limiter or sessions.
  'a grant to drefyn_auth on api_key_failures': {
    rule: 'auth_grant',
    object: 'app.api_key_failures',
    mentions: ['SELECT', 'drefyn_auth'],
    up: () => 'grant select on app.api_key_failures to drefyn_auth;',
  },
  'a grant to drefyn_auth on sessions': {
    rule: 'auth_grant',
    object: 'app.sessions',
    mentions: ['INSERT', 'drefyn_auth'],
    up: () => 'grant insert on app.sessions to drefyn_auth;',
  },
  'an api_access policy on a table other than api_key_failures': {
    rule: 'policy',
    object: 'app.auth_rate_limits',
    mentions: ['api_access'],
    up: () =>
      'create policy api_access on app.auth_rate_limits to drefyn_app using (true) with check (true);',
  },
  // A policy with no TO clause applies to every role, the pools included.
  'a restrictive policy to public': {
    rule: 'public_policy',
    object: 'app.fixture_notes',
    mentions: ['narrow'],
    up: () => `create policy narrow on app.fixture_notes as restrictive using (body <> '');`,
  },
  'a policy to public on a global table': {
    rule: 'public_policy',
    object: 'app.bad_public_global',
    up: () => `${globalTable('bad_public_global')}
create policy deny on app.bad_public_global using (false);`,
    allow: lists(['bad_public_global']),
  },
  'a policy to public and a role': {
    rule: 'public_policy',
    object: 'app.fixture_members',
    up: () =>
      `create policy wide on app.fixture_members as restrictive to drefyn_app, public using (true);`,
  },
};

// Applies the bad file through the real migrate command, as a reviewer would see it fail.
async function withBadMigration(db: TestDatabase, up: string): Promise<void> {
  const dir = fixtureMigrations({
    [FIXTURE_FILE]: migration(fixtureSchemaUp(), FIXTURE_DOWN),
    [BAD_FILE]: migration(up, 'select 1;'),
  });
  const result = await migrate(['migrate', 'up'], { url: db.owner, migrationsDir: dir });
  if (result.code !== 0)
    throw new Error(`bad migration did not apply:\n${describeFailure(result)}`);
}

function describeProblems(problems: readonly CatalogProblem[]): string {
  return problems.map((p) => `${p.rule} ${p.object}: ${p.message}`).join('\n') || 'no problems';
}

function checkCatalogCli(url: string) {
  return run('pnpm', ['run', '--silent', 'check:catalog'], {
    cwd: packageRoot,
    env: { ...process.env, DREFYN_MIGRATION_DATABASE_URL: url, DREFYN_DATABASE_SSL: 'disable' },
  });
}

describeWithStack('catalog check passes', () => {
  it('on the migrated template with the bookkeeping tables present', async () => {
    const db = await dbs.fresh('migrated');
    expect(
      await query(
        db.owner,
        `select to_regclass('app.pgmigrations') is not null as a, to_regclass('app.migration_checksums') is not null as b`,
      ),
    ).toEqual([{ a: true, b: true }]);
    const problems = await catalogProblems(db.owner, ALLOW_LISTS);
    expect(problems, describeProblems(problems)).toEqual([]);
  });

  it('on the fixture schema', async () => {
    const db = await fixture();
    const problems = await catalogProblems(db.owner, FIXTURE_ALLOW_LISTS);
    expect(problems, describeProblems(problems)).toEqual([]);
  });

  // A restrictive policy can only narrow what tenant_isolation lets through.
  it('with an extra restrictive policy on a tenant table', async () => {
    const db = await fixture();
    await withBadMigration(
      db,
      `create policy non_empty on app.fixture_notes as restrictive to drefyn_app
  using (body <> '') with check (body <> '');`,
    );
    const problems = await catalogProblems(db.owner, FIXTURE_ALLOW_LISTS);
    expect(problems, describeProblems(problems)).toEqual([]);
  });

  it('with a foreign key that carries organization and project', async () => {
    const db = await fixture();
    await withBadMigration(
      db,
      `alter table app.fixture_notes add constraint fixture_notes_tenant_id_key unique (organization_id, project_id, id);
${projectTable('ok_fk', ['note_id uuid'])}
alter table app.ok_fk add foreign key (organization_id, project_id, note_id)
  references app.fixture_notes (organization_id, project_id, id);`,
    );
    const problems = await catalogProblems(db.owner, FIXTURE_ALLOW_LISTS);
    expect(problems, describeProblems(problems)).toEqual([]);
  });

  it('with a reviewed cross project foreign key', async () => {
    const db = await fixture();
    await withBadMigration(
      db,
      `alter table app.fixture_notes add constraint fixture_notes_org_id_key unique (organization_id, id);
${projectTable('ok_cross', ['note_id uuid'])}
alter table app.ok_cross add constraint ok_cross_note_fkey foreign key (organization_id, note_id)
  references app.fixture_notes (organization_id, id);`,
    );
    const allow: AllowLists = {
      ...FIXTURE_ALLOW_LISTS,
      crossProjectForeignKeys: [{ name: 'app.ok_cross.ok_cross_note_fkey', reason: 'test only' }],
    };
    const problems = await catalogProblems(db.owner, allow);
    expect(problems, describeProblems(problems)).toEqual([]);
  });

  it('with plain DML for drefyn_auth on a listed auth table', async () => {
    const db = await fixture();
    await withBadMigration(
      db,
      `${globalTable('ok_auth_dml')}
revoke all on app.ok_auth_dml from drefyn_app;
grant select, insert, update, delete on app.ok_auth_dml to drefyn_auth;`,
    );
    const allow = lists(['ok_auth_dml'], { authTables: [reviewed('app.ok_auth_dml')] });
    const problems = await catalogProblems(db.owner, allow);
    expect(problems, describeProblems(problems)).toEqual([]);
  });

  it('with a reviewed user policy on an organization table', async () => {
    const db = await fixture();
    await withBadMigration(
      db,
      `create policy has_email on app.fixture_members for select to drefyn_app using (email <> '');`,
    );
    const allow = lists([], {
      userPolicies: [
        {
          name: 'app.fixture_members.has_email',
          command: 'select',
          roles: ['drefyn_app'],
          using: "(email <> ''::text)",
          withCheck: null,
          reason: 'test only',
        },
      ],
    });
    const problems = await catalogProblems(db.owner, allow);
    expect(problems, describeProblems(problems)).toEqual([]);
  });

  it('with a reviewed global unique key', async () => {
    const db = await fixture();
    await withBadMigration(
      db,
      `${orgTable('ok_slugs', ['slug text not null'])}
create unique index ok_slugs_slug_key on app.ok_slugs (slug);`,
    );
    const allow = lists([], {
      globalUniqueConstraints: [reviewed('app.ok_slugs.ok_slugs_slug_key')],
    });
    const problems = await catalogProblems(db.owner, allow);
    expect(problems, describeProblems(problems)).toEqual([]);
  });

  it('with usage on schema app for drefyn_auth from the shipped migrations', async () => {
    const db = await dbs.fresh('migrated');
    expect(
      await query(db.owner, `select has_schema_privilege('drefyn_auth', 'app', 'USAGE') as usage`),
    ).toEqual([{ usage: true }]);
  });

  it('through check:catalog with exit 0 on the migrated template', async () => {
    const db = await dbs.fresh('migrated');
    const result = await checkCatalogCli(db.owner);
    expect(result.code, describeFailure(result)).toBe(0);
  });
});

describeWithStack('catalog check fails on one bad migration per rule', () => {
  it.each(Object.entries(CASES))('%s', async (_label, bad) => {
    const db = await fixture();
    await withBadMigration(db, bad.up());
    const problems = await catalogProblems(db.owner, bad.allow ?? FIXTURE_ALLOW_LISTS);
    expect(problems, describeProblems(problems)).toContainEqual(
      expect.objectContaining({ rule: bad.rule, object: bad.object }),
    );
    const hit = problems.find((p) => p.rule === bad.rule && p.object === bad.object);
    expect(hit?.message).toContain(bad.object.replace(/\(.*$/, ''));
    for (const word of bad.mentions ?? []) expect(hit?.message, word).toContain(word);
  });

  it('exits 1 through check:catalog, one line per problem naming the object', async () => {
    const db = await dbs.fresh('migrated');
    await query(db.owner, 'grant select on app.pgmigrations to drefyn_app');
    const result = await checkCatalogCli(db.owner);
    expect(result.code, describeFailure(result)).toBe(1);
    expect(result.stderr).toContain('app.pgmigrations');
    expect(result.stderr).toContain('drefyn_app');
  });
});

describeWithStack('catalog check on the bookkeeping tables', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await dbs.fresh('migrated');
  });

  // One at a time, each revoked after, so every failure is caused by that one grant.
  it.each([
    [
      'grant select on app.pgmigrations to drefyn_app',
      'revoke select on app.pgmigrations from drefyn_app',
      'app.pgmigrations',
      'drefyn_app',
    ],
    [
      'grant select on app.migration_checksums to public',
      'revoke select on app.migration_checksums from public',
      'app.migration_checksums',
      'public',
    ],
    [
      'grant usage on sequence app.pgmigrations_id_seq to drefyn_public_reader',
      'revoke usage on sequence app.pgmigrations_id_seq from drefyn_public_reader',
      'app.pgmigrations_id_seq',
      'drefyn_public_reader',
    ],
  ])('fails after %s, naming it and the grantee', async (grant, revoke, object, grantee) => {
    await query(db.owner, grant);
    try {
      const problems = await catalogProblems(db.owner, ALLOW_LISTS);
      const hit = problems.find((p) => p.rule === 'bookkeeping_grant' && p.object === object);
      expect(hit, describeProblems(problems)).toBeDefined();
      expect(hit?.message).toContain(object);
      expect(hit?.message).toContain(grantee);
    } finally {
      await query(db.owner, revoke);
    }
    const after = await catalogProblems(db.owner, ALLOW_LISTS);
    expect(after, describeProblems(after)).toEqual([]);
  });

  it.each(['app.pgmigrations', 'app.migration_checksums'])(
    'fails naming %s when it is taken off the global table allow list',
    async (removed) => {
      const allow: AllowLists = {
        ...ALLOW_LISTS,
        globalTables: ALLOW_LISTS.globalTables.filter((entry) => entry.name !== removed),
      };
      const problems = await catalogProblems(db.owner, allow);
      expect(problems, describeProblems(problems)).toContainEqual(
        expect.objectContaining({ rule: 'tenant_column', object: removed }),
      );
    },
  );

  it('uses timestamptz in both tables, so the type rule needs no exception', async () => {
    const types = await query<{ table: string; column: string; type: string }>(
      db.owner,
      `select c.relname as table, a.attname as column, format_type(a.atttypid, a.atttypmod) as type
         from pg_attribute a join pg_class c on c.oid = a.attrelid
        where c.relnamespace = 'app'::regnamespace and c.relname in ('pgmigrations', 'migration_checksums')
          and a.attnum > 0 and not a.attisdropped and a.atttypid in ('timestamp'::regtype, 'timestamptz'::regtype)
        order by 1, 2`,
    );
    expect(types).toEqual([
      { table: 'migration_checksums', column: 'recorded_at', type: 'timestamp with time zone' },
      { table: 'pgmigrations', column: 'run_on', type: 'timestamp with time zone' },
    ]);
  });
});

describe('catalog case list', () => {
  it('covers every rule the check knows except role settings, which run serially', () => {
    const rules = new Set(Object.values(CASES).map((c) => c.rule));
    for (const rule of [
      'tenant_column',
      'rls_enabled',
      'rls_forced',
      'policy',
      'banned_type',
      'security_definer',
      'view_security_invoker',
      'materialized_view',
      'tenant_unique',
      'reader_grant',
      'public_execute',
      'default_privileges',
      'app_privilege',
      'tenant_foreign_key',
      'auth_grant',
      'column_grant',
      'public_policy',
    ] as const) {
      expect(rules.has(rule), rule).toBe(true);
    }
  });
});

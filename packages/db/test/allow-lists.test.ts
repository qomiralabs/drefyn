import { describe, expect, it } from 'vitest';
import {
  ALLOW_LISTS,
  APP_FUNCTIONS,
  AUTH_ONLY_TABLES,
  AUTH_TABLES,
  AUTH_TENANT_GRANTS,
  COLUMN_GRANT_TABLES,
  COLUMN_GRANTS,
  CROSS_PROJECT_FOREIGN_KEYS,
  GLOBAL_UNIQUE_CONSTRAINTS,
  GLOBAL_TABLES,
  PUBLISHED_TABLES,
  READER_FUNCTIONS,
  RESTRICTIVE_POLICIES,
  SECURITY_DEFINER_FUNCTIONS,
  USER_POLICIES,
  type AllowLists,
  type PolicyEntry,
} from '../src/allow-lists.ts';
import { allowListProblems, globalTableProblems } from '../src/catalog-check.ts';

const BOOKKEEPING = ['app.pgmigrations', 'app.migration_checksums'];

const POLICY: PolicyEntry = {
  name: 'app.users.self_read',
  command: 'select',
  roles: ['drefyn_app'],
  using: '(id = app.current_user_id())',
  withCheck: null,
  reason: 'a user reads their own row',
};
const GUARD: PolicyEntry = {
  name: 'app.memberships.membership_insert_origin',
  command: 'insert',
  roles: ['drefyn_app'],
  using: null,
  withCheck: "(role = 'owner'::text)",
  reason: 'test only',
};
const REASON = 'migration bookkeeping, owner only, no tenant data';
const auth = (name: string, privilege: string) => ({
  name,
  grantee: 'drefyn_auth',
  privilege,
  reason: 'test only',
});

describe('global table allow list', () => {
  it('holds both bookkeeping tables with the reviewed reason', () => {
    for (const name of BOOKKEEPING) {
      expect(GLOBAL_TABLES, name).toContainEqual({ name, reason: REASON });
    }
  });

  it('passes the bookkeeping tables', () => {
    expect(globalTableProblems(BOOKKEEPING, GLOBAL_TABLES)).toEqual([]);
  });

  it.each(BOOKKEEPING)('fails naming %s once its entry is removed', (removed) => {
    const without = GLOBAL_TABLES.filter((entry) => entry.name !== removed);
    const problems = globalTableProblems(BOOKKEEPING, without);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ rule: 'tenant_column', object: removed });
    expect(problems[0]?.message).toContain(removed);
    expect(problems[0]?.message).toContain('organization_id');
  });

  it('fails on a table that was never listed', () => {
    const problems = globalTableProblems(['app.widgets', ...BOOKKEEPING], GLOBAL_TABLES);
    expect(problems.map((p) => p.object)).toEqual(['app.widgets']);
  });

  it('matches names exactly, not by prefix or case', () => {
    const problems = globalTableProblems(
      ['app.pgmigrations_copy', 'app.PGMIGRATIONS', 'public.pgmigrations'],
      GLOBAL_TABLES,
    );
    expect(problems.map((p) => p.object).sort()).toEqual(
      ['app.PGMIGRATIONS', 'app.pgmigrations_copy', 'public.pgmigrations'].sort(),
    );
  });
});

describe('allow lists', () => {
  it('are themselves clean', () => {
    expect(allowListProblems(ALLOW_LISTS)).toEqual([]);
  });

  it('hold only the two tenant context readers for the reader', () => {
    expect(READER_FUNCTIONS.map((f) => f.name).sort()).toEqual([
      'app.current_org()',
      'app.current_project()',
    ]);
  });

  it('let drefyn_app execute the four context readers and the install tier', () => {
    expect(APP_FUNCTIONS.map((f) => f.name).sort()).toEqual([
      'app.current_actor_id()',
      'app.current_org()',
      'app.current_project()',
      'app.current_user_id()',
      'app.install_tier()',
    ]);
  });

  it('keep the install tier away from the public reader', () => {
    expect(READER_FUNCTIONS.map((f) => f.name)).not.toContain('app.install_tier()');
  });

  it('keep the actor reader away from the public reader', () => {
    expect(READER_FUNCTIONS.map((f) => f.name)).not.toContain('app.current_actor_id()');
  });

  it('keep the user reader away from the public reader', () => {
    expect(READER_FUNCTIONS.map((f) => f.name)).not.toContain('app.current_user_id()');
  });

  it('list every identity and limiter table as global, with a reason', () => {
    const tables = [
      'app.api_key_failures',
      'app.auth_rate_limits',
      'app.cli_sign_in_links',
      'app.email_challenges',
      'app.identities',
      'app.oauth_states',
      'app.password_credentials',
      'app.sessions',
      'app.users',
    ];
    for (const name of tables) {
      expect(
        GLOBAL_TABLES.map((t) => t.name),
        name,
      ).toContain(name);
    }
  });

  // The sign in role reaches the tables sign in needs and nothing after it.
  it('let drefyn_auth reach the eight sign in tables, never sessions or the API limiter', () => {
    expect(AUTH_TABLES.map((t) => t.name).sort()).toEqual([
      'app.auth_rate_limits',
      'app.cli_sign_in_links',
      'app.email_challenges',
      'app.identities',
      'app.known_devices',
      'app.oauth_states',
      'app.password_credentials',
      'app.users',
    ]);
  });

  it('keep drefyn_app off the four auth only tables', () => {
    expect(AUTH_ONLY_TABLES.map((t) => t.name).sort()).toEqual([
      'app.auth_rate_limits',
      'app.cli_sign_in_links',
      'app.email_challenges',
      'app.oauth_states',
    ]);
  });

  it('name api_access on api_key_failures only', () => {
    const access = USER_POLICIES.filter((p) => p.name.endsWith('.api_access'));
    expect(access.map((p) => p.name)).toEqual(['app.api_key_failures.api_access']);
  });

  it('grant drefyn_app only id, email, display_name and created_at on users', () => {
    const appSelect = COLUMN_GRANTS.filter(
      (g) =>
        g.name.startsWith('app.users.') && g.grantee === 'drefyn_app' && g.privilege === 'SELECT',
    );
    expect(appSelect.map((g) => g.name).sort()).toEqual([
      'app.users.created_at',
      'app.users.display_name',
      'app.users.email',
      'app.users.id',
    ]);
    const appWrite = COLUMN_GRANTS.filter(
      (g) =>
        g.name.startsWith('app.users.') && g.grantee === 'drefyn_app' && g.privilege !== 'SELECT',
    );
    expect(appWrite.map((g) => `${g.privilege} ${g.name}`).sort()).toEqual([
      'UPDATE app.users.display_name',
      'UPDATE app.users.updated_at',
    ]);
    const authUpdate = COLUMN_GRANTS.filter(
      (g) =>
        g.name.startsWith('app.users.') && g.grantee === 'drefyn_auth' && g.privilege === 'UPDATE',
    );
    expect(authUpdate.map((g) => g.name).sort()).toEqual([
      'app.users.email',
      'app.users.email_normalized',
      'app.users.email_verified_at',
      'app.users.updated_at',
    ]);
  });

  it('control the grants on users, password_credentials and known_devices by column', () => {
    expect(COLUMN_GRANT_TABLES.map((t) => t.name).sort()).toEqual([
      'app.known_devices',
      'app.password_credentials',
      'app.users',
    ]);
  });

  it('let drefyn_auth reach one tenant table, to find and delete old revoked keys', () => {
    expect(ALLOW_LISTS.authTenantGrants).toBe(AUTH_TENANT_GRANTS);
    expect(AUTH_TENANT_GRANTS.map((g) => [g.name, g.grantee, g.privilege]).sort()).toEqual([
      ['app.api_keys', 'drefyn_auth', 'DELETE'],
      ['app.api_keys.ctid', 'drefyn_auth', 'SELECT'],
      ['app.api_keys.revoked_at', 'drefyn_auth', 'SELECT'],
    ]);
    for (const grant of AUTH_TENANT_GRANTS) expect(grant.reason.trim()).not.toBe('');
  });

  it('keep the API key tables off the auth table list, so nothing else opens with them', () => {
    const names = AUTH_TABLES.map((e) => e.name);
    expect(names).not.toContain('app.api_keys');
    expect(names).not.toContain('app.api_key_projects');
  });

  it('bound what drefyn_auth may do to a revoked key by exact text', () => {
    const entries = USER_POLICIES.filter((p) => p.name.startsWith('app.api_keys.'));
    const using = "(revoked_at < (now() - '90 days'::interval))";
    expect(entries.map((p) => [p.name, p.command, p.roles, p.using, p.withCheck])).toEqual([
      ['app.api_keys.auth_expire', 'delete', ['drefyn_auth'], using, null],
      ['app.api_keys.auth_expire_read', 'select', ['drefyn_auth'], using, null],
    ]);
  });

  it('let one column hold more than one reviewed grant', () => {
    const lists: AllowLists = {
      ...ALLOW_LISTS,
      columnGrants: [
        { name: 'app.users.email', grantee: 'drefyn_app', privilege: 'SELECT', reason: 'r' },
        { name: 'app.users.email', grantee: 'drefyn_auth', privilege: 'SELECT', reason: 'r' },
        { name: 'app.users.email', grantee: 'drefyn_auth', privilege: 'UPDATE', reason: 'r' },
      ],
    };
    expect(allowListProblems(lists)).toEqual([]);
  });

  it('start with no cross project foreign key', () => {
    expect(CROSS_PROJECT_FOREIGN_KEYS).toEqual([]);
  });

  it('start with no SECURITY DEFINER function and no published table', () => {
    expect(SECURITY_DEFINER_FUNCTIONS).toEqual([]);
    expect(PUBLISHED_TABLES).toEqual([]);
  });

  it.each<[string, (lists: AllowLists) => AllowLists]>([
    [
      'an auth tenant grant to another role',
      (l) => ({
        ...l,
        authTenantGrants: [{ ...auth('app.api_keys.ctid', 'SELECT'), grantee: 'drefyn_app' }],
      }),
    ],
    [
      'an auth tenant grant that can write a row',
      (l) => ({ ...l, authTenantGrants: [auth('app.api_keys.revoked_at', 'UPDATE')] }),
    ],
    [
      'an auth tenant grant to insert',
      (l) => ({ ...l, authTenantGrants: [auth('app.api_keys', 'INSERT')] }),
    ],
    [
      'an auth tenant select of a whole table',
      (l) => ({ ...l, authTenantGrants: [auth('app.api_keys', 'SELECT')] }),
    ],
    [
      'an auth tenant delete of one column',
      (l) => ({ ...l, authTenantGrants: [auth('app.api_keys.revoked_at', 'DELETE')] }),
    ],
    [
      'an auth tenant grant with no reason',
      (l) => ({
        ...l,
        authTenantGrants: [{ ...auth('app.api_keys.ctid', 'SELECT'), reason: ' ' }],
      }),
    ],
    [
      'an auth tenant grant listed twice',
      (l) => ({
        ...l,
        authTenantGrants: [
          auth('app.api_keys.ctid', 'SELECT'),
          auth('app.api_keys.ctid', 'SELECT'),
        ],
      }),
    ],
    [
      'an empty reason',
      (l) => ({ ...l, globalTables: [...l.globalTables, { name: 'app.x', reason: '' }] }),
    ],
    [
      'a blank reason',
      (l) => ({ ...l, publishedTables: [...l.publishedTables, { name: 'app.x', reason: '  ' }] }),
    ],
    [
      'a duplicate entry',
      (l) => ({
        ...l,
        globalTables: [...l.globalTables, { name: 'app.pgmigrations', reason: 'again' }],
      }),
    ],
    [
      'a name outside schema app',
      (l) => ({
        ...l,
        securityDefinerFunctions: [{ name: 'public.f()', reason: 'reviewed' }],
      }),
    ],
    [
      'an unqualified name',
      (l) => ({ ...l, publishedTables: [{ name: 'pages', reason: 'reviewed' }] }),
    ],
    [
      'an app function outside schema app',
      (l) => ({ ...l, appFunctions: [{ name: 'public.f()', reason: 'reviewed' }] }),
    ],
    [
      'a cross project key that is not table.constraint',
      (l) => ({ ...l, crossProjectForeignKeys: [{ name: 'app.notes', reason: 'reviewed' }] }),
    ],
    [
      'an auth table outside schema app',
      (l) => ({ ...l, authTables: [{ name: 'public.users', reason: 'reviewed' }] }),
    ],
    [
      'a global unique key that is not table.index',
      (l) => ({ ...l, globalUniqueConstraints: [{ name: 'app.slugs', reason: 'reviewed' }] }),
    ],
    [
      'a user policy that is not table.policy',
      (l) => ({ ...l, userPolicies: [{ ...POLICY, name: 'app.users' }] }),
    ],
    [
      'a user policy for every role',
      (l) => ({ ...l, userPolicies: [{ ...POLICY, roles: ['public'] }] }),
    ],
    ['a user policy for no role', (l) => ({ ...l, userPolicies: [{ ...POLICY, roles: [] }] })],
    [
      'a user policy listed twice',
      (l) => ({ ...l, userPolicies: [POLICY, { ...POLICY, reason: 'again' }] }),
    ],
    [
      'a restrictive policy that is not table.policy',
      (l) => ({ ...l, restrictivePolicies: [{ ...GUARD, name: 'app.memberships' }] }),
    ],
    [
      'a restrictive policy for every role',
      (l) => ({ ...l, restrictivePolicies: [{ ...GUARD, roles: ['public'] }] }),
    ],
    [
      'a restrictive policy for no role',
      (l) => ({ ...l, restrictivePolicies: [{ ...GUARD, roles: [] }] }),
    ],
    [
      'a restrictive policy listed twice',
      (l) => ({ ...l, restrictivePolicies: [GUARD, { ...GUARD, reason: 'again' }] }),
    ],
    [
      'a restrictive policy with no reason',
      (l) => ({ ...l, restrictivePolicies: [{ ...GUARD, reason: ' ' }] }),
    ],
    // A permissive policy keyed to the actor would OR in rows of other organizations the
    // person belongs to; the actor only ever narrows.
    [
      'a user policy that reads the actor',
      (l) => ({
        ...l,
        userPolicies: [{ ...POLICY, using: '(user_id = app.current_actor_id())' }],
      }),
    ],
    [
      'a user policy that checks the actor',
      (l) => ({
        ...l,
        userPolicies: [{ ...POLICY, withCheck: '(user_id = app.current_actor_id())' }],
      }),
    ],
    [
      'a restrictive policy also listed as a user policy',
      (l) => ({ ...l, userPolicies: [...l.userPolicies, { ...GUARD }] }),
    ],
    [
      'a column grant that is not table.column',
      (l) => ({
        ...l,
        columnGrants: [
          { name: 'app.users', grantee: 'drefyn_app', privilege: 'SELECT', reason: 'r' },
        ],
      }),
    ],
    [
      'a column grant listed twice',
      (l) => {
        const entry = {
          name: 'app.users.email',
          grantee: 'drefyn_app',
          privilege: 'SELECT',
          reason: 'r',
        };
        return { ...l, columnGrants: [entry, entry] };
      },
    ],
    [
      'a column grant to public',
      (l) => ({
        ...l,
        columnGrants: [
          { name: 'app.users.email', grantee: 'public', privilege: 'SELECT', reason: 'r' },
        ],
      }),
    ],
    [
      'a column grant with a lower case privilege',
      (l) => ({
        ...l,
        columnGrants: [
          { name: 'app.users.email', grantee: 'drefyn_app', privilege: 'select', reason: 'r' },
        ],
      }),
    ],
    [
      'a column grant for a privilege that is never per column here',
      (l) => ({
        ...l,
        columnGrants: [
          { name: 'app.users.email', grantee: 'drefyn_app', privilege: 'REFERENCES', reason: 'r' },
        ],
      }),
    ],
    [
      'a column grant to a role that is not a pool role',
      (l) => ({
        ...l,
        columnGrants: [
          { name: 'app.users.email', grantee: 'drefyn_owner', privilege: 'SELECT', reason: 'r' },
        ],
      }),
    ],
    [
      'a column grant to the public reader',
      (l) => ({
        ...l,
        columnGrants: [
          {
            name: 'app.users.email',
            grantee: 'drefyn_public_reader',
            privilege: 'SELECT',
            reason: 'r',
          },
        ],
      }),
    ],
    [
      'a column grant on a table that is not column controlled',
      (l) => ({
        ...l,
        columnGrants: [
          { name: 'app.sessions.user_id', grantee: 'drefyn_app', privilege: 'SELECT', reason: 'r' },
        ],
      }),
    ],
    [
      'an auth only table that is not an auth table',
      (l) => ({ ...l, authOnlyTables: [{ name: 'app.sessions', reason: 'reviewed' }] }),
    ],
    [
      'an auth only table outside schema app',
      (l) => ({ ...l, authOnlyTables: [{ name: 'public.x', reason: 'reviewed' }] }),
    ],
    [
      'a column controlled table outside schema app',
      (l) => ({ ...l, columnGrantTables: [{ name: 'users', reason: 'reviewed' }] }),
    ],
  ])('fail on %s', (_label, change) => {
    const problems = allowListProblems(change(ALLOW_LISTS));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((p) => p.rule === 'allow_list')).toBe(true);
  });
});

describe('organization entries', () => {
  it('list the one global unique key, the slug namespace, with its reason', () => {
    expect(GLOBAL_UNIQUE_CONSTRAINTS.map((e) => e.name)).toEqual([
      'app.organization_slugs.organization_slugs_slug_key',
    ]);
    expect(GLOBAL_UNIQUE_CONSTRAINTS[0]?.reason).toMatch(/one public namespace/);
  });

  it('keep the organization tables off the global and auth lists', () => {
    const names = (list: readonly { name: string }[]) => list.map((e) => e.name);
    for (const table of ['organizations', 'organization_slugs', 'memberships', 'projects']) {
      expect(names(GLOBAL_TABLES)).not.toContain(`app.${table}`);
      expect(names(AUTH_TABLES)).not.toContain(`app.${table}`);
    }
  });

  it('let a user context only select the organizations and slugs it is a member of', () => {
    const byName = new Map(USER_POLICIES.map((p) => [p.name, p]));
    for (const table of ['organizations', 'organization_slugs']) {
      const policy = byName.get(`app.${table}.member_read`);
      expect(policy, table).toMatchObject({
        command: 'select',
        roles: ['drefyn_app'],
        withCheck: null,
      });
      expect(policy?.using).toContain('app.memberships');
      expect(policy?.using).toContain('app.current_user_id()');
    }
    expect(byName.get('app.memberships.self_read')).toMatchObject({
      command: 'select',
      roles: ['drefyn_app'],
      using: '(user_id = app.current_user_id())',
      withCheck: null,
    });
    expect(byName.has('app.projects.member_read')).toBe(false);
  });

  it('let organization work read only the users who are its members', () => {
    const byName = new Map(USER_POLICIES.map((p) => [p.name, p]));
    expect(byName.get('app.users.member_read')).toMatchObject({
      command: 'select',
      roles: ['drefyn_app'],
      using:
        '(EXISTS ( SELECT\n   FROM app.memberships m\n  WHERE ((m.user_id = users.id) AND (m.organization_id = app.current_org()))))',
      withCheck: null,
    });
  });
});

// pg_get_expr text, read back from Postgres with search_path = pg_catalog.
const OWNER_ARM =
  "((role = 'owner'::text) AND (NOT (EXISTS ( SELECT\n   FROM app.memberships m\n  WHERE (m.organization_id = memberships.organization_id)))) AND (EXISTS ( SELECT\n   FROM app.organizations o\n  WHERE ((o.organization_id = memberships.organization_id) AND (o.created_at = now())))))";
const INVITATION_ARM =
  '(EXISTS ( SELECT\n   FROM app.invitations i\n  WHERE ((i.organization_id = memberships.organization_id) AND (i.id = memberships.invitation_id) AND (i.role = memberships.role) AND (i.expires_at > now()))))';
const ORIGIN = `((user_id = app.current_actor_id()) AND (${OWNER_ARM} OR ${INVITATION_ARM}))`;
const INVITER =
  "(EXISTS ( SELECT\n   FROM app.memberships m\n  WHERE ((m.organization_id = invitations.organization_id) AND (m.id = invitations.invited_by) AND (m.user_id = app.current_actor_id()) AND ((m.role = 'owner'::text) OR ((m.role = 'admin'::text) AND (invitations.role <> 'owner'::text))))))";

const KEY_CREATOR =
  "(EXISTS ( SELECT\n   FROM app.memberships m\n  WHERE ((m.organization_id = api_keys.organization_id) AND (m.id = api_keys.created_by) AND (m.user_id = app.current_actor_id()) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text])))))";

const ACTOR_ON_MEMBERSHIP =
  "(EXISTS ( SELECT\n   FROM app.memberships a\n  WHERE ((a.organization_id = memberships.organization_id) AND (a.user_id = app.current_actor_id()) AND ((a.role = 'owner'::text) OR ((a.role = 'admin'::text) AND (memberships.role <> 'owner'::text))))))";
const ANOTHER_OWNER =
  "(EXISTS ( SELECT\n   FROM app.memberships o\n  WHERE ((o.organization_id = memberships.organization_id) AND (o.role = 'owner'::text) AND (o.id <> memberships.id))))";
const ACTOR_ON_PROJECT_ROLE =
  "(EXISTS ( SELECT\n   FROM app.memberships a\n  WHERE ((a.organization_id = project_roles.organization_id) AND (a.user_id = app.current_actor_id()) AND (a.role = ANY (ARRAY['owner'::text, 'admin'::text])))))";

describe('restrictive policies', () => {
  it('are in ALLOW_LISTS', () => {
    expect(ALLOW_LISTS.restrictivePolicies).toBe(RESTRICTIVE_POLICIES);
  });

  it('list the insert and update guards, for drefyn_app, with their exact text', () => {
    expect(
      RESTRICTIVE_POLICIES.map(({ name, command, roles, using, withCheck }) => ({
        name,
        command,
        roles,
        using,
        withCheck,
      })),
    ).toEqual([
      {
        name: 'app.api_keys.api_key_insert_creator',
        command: 'insert',
        roles: ['drefyn_app'],
        using: null,
        withCheck: KEY_CREATOR,
      },
      {
        name: 'app.api_keys.api_key_update_unrevoked',
        command: 'update',
        roles: ['drefyn_app'],
        using: '(revoked_at IS NULL)',
        withCheck: 'true',
      },
      {
        name: 'app.invitations.invitation_insert_inviter',
        command: 'insert',
        roles: ['drefyn_app'],
        using: null,
        withCheck: INVITER,
      },
      {
        name: 'app.invitations.invitation_update_inviter',
        command: 'update',
        roles: ['drefyn_app'],
        using: 'true',
        withCheck: INVITER,
      },
      {
        name: 'app.memberships.membership_delete_actor',
        command: 'delete',
        roles: ['drefyn_app'],
        using: `(${ACTOR_ON_MEMBERSHIP} AND ((role <> 'owner'::text) OR ${ANOTHER_OWNER}))`,
        withCheck: null,
      },
      {
        name: 'app.memberships.membership_insert_origin',
        command: 'insert',
        roles: ['drefyn_app'],
        using: null,
        withCheck: ORIGIN,
      },
      {
        name: 'app.memberships.membership_update_actor',
        command: 'update',
        roles: ['drefyn_app'],
        using: ACTOR_ON_MEMBERSHIP,
        withCheck: `(${ACTOR_ON_MEMBERSHIP} AND ((role = 'owner'::text) OR ${ANOTHER_OWNER}))`,
      },
      {
        name: 'app.organizations.organization_insert_tier',
        command: 'insert',
        roles: ['drefyn_app'],
        using: null,
        withCheck: '((plan_tier = app.install_tier()) AND (read_only_since IS NULL))',
      },
      {
        name: 'app.project_roles.project_role_delete_actor',
        command: 'delete',
        roles: ['drefyn_app'],
        using: ACTOR_ON_PROJECT_ROLE,
        withCheck: null,
      },
      {
        name: 'app.project_roles.project_role_insert_actor',
        command: 'insert',
        roles: ['drefyn_app'],
        using: null,
        withCheck: ACTOR_ON_PROJECT_ROLE,
      },
      {
        name: 'app.project_roles.project_role_update_actor',
        command: 'update',
        roles: ['drefyn_app'],
        using: ACTOR_ON_PROJECT_ROLE,
        withCheck: ACTOR_ON_PROJECT_ROLE,
      },
    ]);
    for (const entry of RESTRICTIVE_POLICIES) expect(entry.reason.trim(), entry.name).not.toBe('');
  });

  it('give the owner arm no way in for an admin or a member', () => {
    const origin = RESTRICTIVE_POLICIES.find((p) => p.name.endsWith('.membership_insert_origin'));
    expect(origin?.withCheck).not.toMatch(/'(admin|member)'/);
  });

  it('let only an owner or admin membership of the same organization create a key', () => {
    const creator = RESTRICTIVE_POLICIES.find((p) => p.name.endsWith('.api_key_insert_creator'));
    expect(creator?.withCheck).toContain('m.organization_id = api_keys.organization_id');
    expect(creator?.withCheck).toContain('m.id = api_keys.created_by');
    expect(creator?.withCheck).not.toMatch(/'member'/);
  });

  // Creating an organization makes its creator the owner, and accepting makes the invitee
  // the member, so in both arms the new row names the person acting and nobody else.
  it('bind the key creator, the inviter and the new member to the acting person', () => {
    const byName = new Map(RESTRICTIVE_POLICIES.map((p) => [p.name, p]));
    for (const name of [
      'app.api_keys.api_key_insert_creator',
      'app.invitations.invitation_insert_inviter',
      'app.invitations.invitation_update_inviter',
    ]) {
      expect(byName.get(name)?.withCheck, name).toContain('(m.user_id = app.current_actor_id())');
    }
    expect(byName.get('app.memberships.membership_insert_origin')?.withCheck).toMatch(
      /^\(\(user_id = app\.current_actor_id\(\)\) AND \(/,
    );
  });

  it('let any other member in only on a live invitation of this organization with the same role', () => {
    const origin = RESTRICTIVE_POLICIES.find((p) => p.name.endsWith('.membership_insert_origin'));
    const arm = origin?.withCheck?.split(' OR ')[1] ?? '';
    for (const part of [
      'i.organization_id = memberships.organization_id',
      'i.id = memberships.invitation_id',
      'i.role = memberships.role',
      'i.expires_at > now()',
    ]) {
      expect(arm, part).toContain(part);
    }
  });

  // An admin must never reach an owner row, nor write owner; nothing may leave no owner.
  it('keep an admin off owner rows and every organization with an owner', () => {
    const byName = new Map(RESTRICTIVE_POLICIES.map((p) => [p.name, p]));
    const update = byName.get('app.memberships.membership_update_actor');
    const remove = byName.get('app.memberships.membership_delete_actor');
    for (const text of [update?.using, update?.withCheck, remove?.using]) {
      expect(text).toContain("(a.role = 'admin'::text) AND (memberships.role <> 'owner'::text)");
      expect(text).toContain('a.user_id = app.current_actor_id()');
    }
    expect(update?.withCheck).toContain('o.id <> memberships.id');
    expect(remove?.using).toContain('o.id <> memberships.id');
  });

  it('pass with an entry that is clean', () => {
    expect(allowListProblems({ ...ALLOW_LISTS, restrictivePolicies: [GUARD] })).toEqual([]);
  });
});

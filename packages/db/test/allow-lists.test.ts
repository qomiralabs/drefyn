import { describe, expect, it } from 'vitest';
import {
  ALLOW_LISTS,
  APP_FUNCTIONS,
  AUTH_ONLY_TABLES,
  AUTH_TABLES,
  COLUMN_GRANT_TABLES,
  COLUMN_GRANTS,
  CROSS_PROJECT_FOREIGN_KEYS,
  GLOBAL_UNIQUE_CONSTRAINTS,
  GLOBAL_TABLES,
  PUBLISHED_TABLES,
  READER_FUNCTIONS,
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
const REASON = 'migration bookkeeping, owner only, no tenant data';

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

  it('let drefyn_app execute only the three context readers', () => {
    expect(APP_FUNCTIONS.map((f) => f.name).sort()).toEqual([
      'app.current_org()',
      'app.current_project()',
      'app.current_user_id()',
    ]);
  });

  it('keep the user reader away from the public reader', () => {
    expect(READER_FUNCTIONS.map((f) => f.name)).not.toContain('app.current_user_id()');
  });

  it('list every identity and limiter table as global, with a reason', () => {
    const tables = [
      'app.api_key_failures',
      'app.auth_rate_limits',
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
  it('let drefyn_auth reach the six sign in tables, never sessions or the API limiter', () => {
    expect(AUTH_TABLES.map((t) => t.name).sort()).toEqual([
      'app.auth_rate_limits',
      'app.email_challenges',
      'app.identities',
      'app.oauth_states',
      'app.password_credentials',
      'app.users',
    ]);
  });

  it('keep drefyn_app off the three auth only tables', () => {
    expect(AUTH_ONLY_TABLES.map((t) => t.name).sort()).toEqual([
      'app.auth_rate_limits',
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

  it('control the grants on users and password_credentials by column', () => {
    expect(COLUMN_GRANT_TABLES.map((t) => t.name).sort()).toEqual([
      'app.password_credentials',
      'app.users',
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
});

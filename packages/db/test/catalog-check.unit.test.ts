import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { ALLOW_LISTS, type PolicyEntry } from '../src/allow-lists.ts';
import { allowListProblems, checkCatalog, runCheckCatalog } from '../src/catalog-check.ts';
import { rejected } from './support.ts';

type Rows = Record<string, unknown>[];

// Answers the catalog queries by a word they contain; anything else returns no rows.
function fakeClient(answers: readonly [RegExp, Rows][]) {
  const sent: string[] = [];
  const client = {
    query: (sql: string) => {
      sent.push(sql.trim().split('\n')[0] ?? '');
      const hit = answers.find(([pattern]) => pattern.test(sql));
      return Promise.resolve({ rows: hit?.[1] ?? [] });
    },
  };
  return { client: client as unknown as pg.ClientBase, sent };
}

const TABLES = /relforcerowsecurity as forced/;
const POLICIES = /from pg_policy p/;
const table = { name: 'app.t', organization_column: 'uuid not null', project_column: null };

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

describe('checkCatalog on rows it does not expect', () => {
  it.each<[string, readonly [RegExp, Rows][]]>([
    ['a name that is not text', [[TABLES, [{ ...table, name: 1 }]]]],
    ['a column type that is not text', [[TABLES, [{ ...table, organization_column: 7 }]]]],
    ['a flag that is not a boolean', [[TABLES, [{ ...table, rls: 'yes', forced: true }]]]],
    [
      'roles that are not a text list',
      [
        [TABLES, [{ ...table, rls: true, forced: true }]],
        [POLICIES, [{ table_name: 'app.t', name: 'p', cmd: '*', permissive: true, roles: 'x' }]],
      ],
    ],
  ])('fails loudly on %s and still ends its transaction', async (_label, answers) => {
    const { client, sent } = fakeClient(answers);
    const error = await rejected(checkCatalog(client));
    expect(String(error)).toMatch(/catalog check/);
    expect(sent.at(-1)).toBe('rollback');
  });
});

describe('the restrictive policy rule', () => {
  const ISOLATION = '(organization_id = app.current_org())';
  const GUARD: PolicyEntry = {
    name: 'app.t.guard',
    command: 'insert',
    roles: ['drefyn_app'],
    using: null,
    withCheck: "(body <> ''::text)",
    reason: 'test only',
  };
  const policy = (over: Record<string, unknown> = {}) => ({
    table_name: 'app.t',
    name: 'guard',
    cmd: 'a',
    permissive: false,
    roles: ['drefyn_app'],
    qual: null,
    with_check: GUARD.withCheck,
    ...over,
  });
  const isolation = {
    table_name: 'app.t',
    name: 'tenant_isolation',
    cmd: '*',
    permissive: true,
    roles: ['drefyn_app'],
    qual: ISOLATION,
    with_check: ISOLATION,
  };

  async function problemsWith(policies: Rows, entries: readonly PolicyEntry[]) {
    const { client } = fakeClient([
      [TABLES, [{ ...table, rls: true, forced: true }]],
      [POLICIES, [isolation, ...policies]],
    ]);
    const problems = await checkCatalog(client, { ...ALLOW_LISTS, restrictivePolicies: entries });
    return problems.filter((p) => p.rule === 'restrictive_policy');
  }

  it('passes a listed policy that matches', async () => {
    expect(await problemsWith([policy()], [GUARD])).toEqual([]);
  });

  it('fails an unlisted restrictive policy', async () => {
    const problems = await problemsWith([policy()], []);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ object: 'app.t' });
    expect(problems[0]?.message).toContain('not on the restrictive policy allow list');
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['WITH CHECK', { with_check: '(true)' }, 'WITH CHECK clause other than'],
    ['USING', { qual: '(true)' }, 'USING clause other than'],
    ['command', { cmd: '*' }, 'is for all, not insert'],
    ['roles', { roles: ['drefyn_app', 'drefyn_auth'] }, 'is to drefyn_app, drefyn_auth'],
  ])('fails a listed policy whose %s differs', async (_label, over, words) => {
    const problems = await problemsWith([policy(over)], [GUARD]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain('restrictive policy guard');
    expect(problems[0]?.message).toContain(words);
  });

  it('fails a listed policy that is missing or permissive', async () => {
    for (const rows of [[], [policy({ permissive: true })]]) {
      const problems = await problemsWith(rows, [GUARD]);
      expect(problems).toEqual([
        {
          rule: 'restrictive_policy',
          object: 'app.t',
          message: 'app.t is missing the restrictive policy guard on its allow list',
        },
      ]);
    }
  });

  // One CI run against the migrated database must be enough to correct an entry, so the
  // text Postgres holds is in the message.
  it('prints the text the database holds when a clause differs', async () => {
    const problems = await problemsWith([policy({ with_check: '(body = 1)' })], [GUARD]);
    expect(problems[0]?.message).toContain('actual: "(body = 1)"');
  });
});

describe('the actor rule', () => {
  const ACTOR = '(user_id = app.current_actor_id())';
  const ISOLATION = '(organization_id = app.current_org())';
  const row = (over: Record<string, unknown>) => ({
    table_name: 'app.t',
    name: 'tenant_isolation',
    cmd: '*',
    permissive: true,
    roles: ['drefyn_app'],
    qual: ISOLATION,
    with_check: ISOLATION,
    ...over,
  });
  const GUARD: PolicyEntry = {
    name: 'app.t.guard',
    command: 'insert',
    roles: ['drefyn_app'],
    using: null,
    withCheck: ACTOR,
    reason: 'test only',
  };

  async function actorProblems(policies: Rows, allow = ALLOW_LISTS) {
    const { client } = fakeClient([
      [TABLES, [{ ...table, rls: true, forced: true }]],
      [POLICIES, policies],
    ]);
    const problems = await checkCatalog(client, allow);
    return problems.filter((p) => p.rule === 'actor_policy');
  }

  it('passes a restrictive policy that reads the actor', async () => {
    const guard = row({
      name: 'guard',
      cmd: 'a',
      permissive: false,
      qual: null,
      with_check: ACTOR,
    });
    expect(
      await actorProblems([row({}), guard], { ...ALLOW_LISTS, restrictivePolicies: [GUARD] }),
    ).toEqual([]);
  });

  it.each<[string, Record<string, unknown>]>([
    ['USING', { name: 'wide', cmd: 'r', qual: ACTOR, with_check: null }],
    ['WITH CHECK', { name: 'wide', cmd: 'a', qual: null, with_check: ACTOR }],
    ['a listed name', { name: 'self_read', cmd: 'r', qual: ACTOR, with_check: null }],
  ])('fails a permissive policy that reads the actor in %s', async (_label, over) => {
    const problems = await actorProblems([row({}), row(over)]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ object: 'app.t' });
    expect(problems[0]?.message).toContain(String(over['name']));
    expect(problems[0]?.message).toContain('app.current_actor_id()');
  });
});

describe('the organization table rule', () => {
  const ISOLATION = '(organization_id = app.current_org())';
  const SSO = ['app.sso_connections', 'app.sso_domains', 'app.sso_identities', 'app.sso_states'];
  const tenant = (name: string, project: string | null = null) => ({
    name,
    organization_column: 'uuid not null',
    project_column: project,
    rls: true,
    forced: true,
  });
  const isolation = (name: string) => ({
    table_name: name,
    name: 'tenant_isolation',
    cmd: '*',
    permissive: true,
    roles: ['drefyn_app'],
    qual: ISOLATION,
    with_check: ISOLATION,
  });

  async function organizationProblems(names: readonly string[], allow = ALLOW_LISTS) {
    const { client } = fakeClient([
      [TABLES, names.map((name) => tenant(name))],
      [POLICIES, names.map(isolation)],
    ]);
    return (await checkCatalog(client, allow)).filter((p) => p.rule === 'organization_table');
  }

  it('lists the SSO tables as organization scoped, with the reviewed reason', () => {
    for (const name of SSO) {
      expect(ALLOW_LISTS.organizationTables.find((e) => e.name === name)?.reason, name).toBe(
        'SSO is organization scoped',
      );
    }
  });

  it('passes the SSO tables with their entries', async () => {
    expect(await organizationProblems(SSO)).toEqual([]);
  });

  // A tenant table that leaves project_id out is readable by organization work across every
  // project, so that choice is reviewed per table.
  it.each(SSO)('fails %s without its entry', async (name) => {
    const allow = {
      ...ALLOW_LISTS,
      organizationTables: ALLOW_LISTS.organizationTables.filter((e) => e.name !== name),
    };
    expect(await organizationProblems(SSO, allow)).toEqual([
      {
        rule: 'organization_table',
        object: name,
        message: `${name} has organization_id and no project_id, and is not on the organization table allow list`,
      },
    ]);
  });

  it('leaves a project table alone', async () => {
    const { client } = fakeClient([
      [TABLES, [tenant('app.notes', 'uuid not null')]],
      [POLICIES, []],
    ]);
    const problems = await checkCatalog(client, ALLOW_LISTS);
    expect(problems.filter((p) => p.rule === 'organization_table')).toEqual([]);
  });
});

describe('the global unique key on SSO domains', () => {
  const UNIQUE = /x\.indisunique/;
  const KEY = 'app.sso_domains.sso_domains_verified_domain_key';
  const domains = {
    name: 'app.sso_domains',
    organization_column: 'uuid not null',
    project_column: null,
    rls: true,
    forced: true,
  };
  const index = {
    table_name: 'app.sso_domains',
    index_name: 'sso_domains_verified_domain_key',
    columns: ['domain'],
    has_expressions: false,
  };

  async function uniqueProblems(allow = ALLOW_LISTS) {
    const { client } = fakeClient([
      [TABLES, [domains]],
      [UNIQUE, [index]],
    ]);
    return (await checkCatalog(client, allow)).filter((p) => p.rule === 'tenant_unique');
  }

  it('is reviewed with its reason', () => {
    expect(ALLOW_LISTS.globalUniqueConstraints.find((e) => e.name === KEY)?.reason).toBe(
      'a domain has one SSO owner',
    );
  });

  it('passes with the entry and fails without it', async () => {
    expect(await uniqueProblems()).toEqual([]);
    const without = {
      ...ALLOW_LISTS,
      globalUniqueConstraints: ALLOW_LISTS.globalUniqueConstraints.filter((e) => e.name !== KEY),
    };
    expect(await uniqueProblems(without)).toEqual([
      {
        rule: 'tenant_unique',
        object: 'app.sso_domains',
        message:
          'app.sso_domains has unique index sso_domains_verified_domain_key without organization_id',
      },
    ]);
  });
});

describe('auth tenant grant entries', () => {
  const entry = (name: string, privilege: string) => ({
    name,
    grantee: 'drefyn_auth',
    privilege,
    reason: 'test only',
  });
  const problemsFor = (grant: ReturnType<typeof entry>) =>
    allowListProblems({ ...ALLOW_LISTS, authTenantGrants: [grant] }).map((p) => p.message);

  // Sign in writes an SSO identity and a state row, each named column by column.
  it('accept insert on a named column', () => {
    expect(problemsFor(entry('app.t.subject', 'INSERT'))).toEqual([]);
  });

  it.each([
    ['insert on a whole table', 'app.t', 'INSERT'],
    ['update on a column', 'app.t.subject', 'UPDATE'],
    ['select on a whole table', 'app.t', 'SELECT'],
    ['delete on a column', 'app.t.subject', 'DELETE'],
  ])('refuse %s', (_label, name, privilege) => {
    expect(problemsFor(entry(name, privilege))).toEqual([
      `auth tenant grant entry ${name} is for ${privilege}; only SELECT or INSERT on a column or DELETE on a table are allowed`,
    ]);
  });
});

describe('check:catalog without a database', () => {
  it('exits 1 naming the missing key', async () => {
    const err = output();
    const code = await runCheckCatalog({ env: {}, stdout: output().stream, stderr: err.stream });
    expect(code).toBe(1);
    expect(err.text()).toContain('DREFYN_MIGRATION_DATABASE_URL');
  });

  it('exits 1 with DB_UNAVAILABLE and no password when nothing listens', async () => {
    const err = output();
    const code = await runCheckCatalog({
      env: {
        DREFYN_MIGRATION_DATABASE_URL:
          'postgres://drefyn_owner:Sup3r-Secret-Pa55word@127.0.0.1:1/drefyn',
        DREFYN_DATABASE_SSL: 'disable',
      },
      stdout: output().stream,
      stderr: err.stream,
    });
    expect(code).toBe(1);
    expect(err.text()).toContain('DB_UNAVAILABLE');
    expect(err.text()).not.toContain('Sup3r-Secret-Pa55word');
  });
});

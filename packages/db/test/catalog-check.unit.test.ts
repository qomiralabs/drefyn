import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { ALLOW_LISTS, type PolicyEntry } from '../src/allow-lists.ts';
import { checkCatalog, runCheckCatalog } from '../src/catalog-check.ts';
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

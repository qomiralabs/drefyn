import { join } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { makeEslint, repoRoot, reports } from './helpers.ts';

const RULE = 'drefyn/no-select-all';
const eslint = makeEslint(repoRoot, {
  [RULE]: ['error', { tables: ['users', 'password_credentials'] }],
});

async function lint(code: string) {
  const results = await eslint.lintText(code, { filePath: join(repoRoot, 'probe.ts') });
  return reports(results).filter((r) => r.ruleId === RULE);
}

describe('no-select-all', () => {
  it.each([
    "tx.selectFrom('users').selectAll();",
    "tx.selectFrom('password_credentials').selectAll().execute();",
    "tx.selectFrom('users').where('id', '=', id).orderBy('id').selectAll();",
    "tx.selectFrom('app.users').selectAll();",
    "tx.selectFrom('users as u').selectAll('u');",
    "tx.selectFrom('sessions').innerJoin('users', 'users.id', 'sessions.user_id').selectAll();",
    "tx.selectFrom('sessions').innerJoin('users as u', 'u.id', 'sessions.user_id').selectAll('u');",
    "tx.selectFrom(['sessions', 'users']).selectAll();",
    "tx.selectFrom('sessions').selectAll('users');",
    "tx.selectFrom('sessions').selectAll(['sessions', 'password_credentials']);",
    "tx.selectFrom('users AS u').selectAll('u');",
    "tx.selectFrom('app.users as u').selectAll('u');",
    "tx.selectFrom('app.users as u').selectAll();",
    'tx.selectFrom(`users`).selectAll();',
    "const q = tx.selectFrom('users'); q.selectAll();",
    "const q = tx.selectFrom('sessions').innerJoin('users', 'users.id', 'sessions.user_id'); q.selectAll();",
    "const a = tx.selectFrom('users'); const b = a.where('id', '=', id); b.orderBy('id').selectAll();",
    "let q = tx.selectFrom('sessions'); q = tx.selectFrom('users'); q.selectAll();",
    "tx.selectFrom('users')!.selectAll();",
    "(tx.selectFrom('users') as never).selectAll();",
    "tx.selectFrom('users')?.selectAll();",
  ])('refuses %s', async (code) => {
    const found = await lint(code);
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('select *');
  });

  it.each([
    "tx.selectFrom('users').select(['id', 'email']);",
    "tx.selectFrom('sessions').selectAll();",
    "tx.selectFrom('sessions').innerJoin('users', 'users.id', 'sessions.user_id').selectAll('sessions');",
    "tx.selectFrom('identities as users').selectAll();",
    'db.selectAll();',
    'selectAll();',
    'tx.selectFrom(table).selectAll();',
    "tx.selectFrom('users as').selectAll();",
    "tx.selectFrom('users as u extra').selectAll();",
    // A controlled name in another method's first argument reads no table.
    "tx.selectFrom('sessions').where('users', '=', id).selectAll();",
    "tx.selectFrom('sessions').orderBy('password_credentials').selectAll();",
    "const q = tx.selectFrom('sessions'); q.selectAll();",
    "const q = tx.selectFrom('users'); q.select(['id']);",
    // A loop of names must end, not hang the linter.
    'let a = b; let b = a; a.selectAll();',
  ])('allows %s', async (code) => {
    expect(await lint(code)).toEqual([]);
  });

  it.each([
    ["tx.updateTable('users').set({ a: 1 }).returningAll();", 'users'],
    ["tx.insertInto('app.users').values(v).returningAll().execute();", 'users'],
    [
      "tx.deleteFrom('password_credentials').where('id', '=', id).returningAll();",
      'password_credentials',
    ],
    ["tx.updateTable('users as u').set({ a: 1 }).returningAll('u');", 'users'],
    ["const q = tx.updateTable('users'); q.returningAll();", 'users'],
  ])('refuses %s, which sends returning *', async (code, table) => {
    const found = await lint(code);
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('returning *');
    expect(found[0]?.message).toContain(table);
  });

  it.each([
    "tx.updateTable('sessions').set({ a: 1 }).returningAll();",
    "tx.insertInto('sessions').values(v).returning(['id']);",
    "tx.updateTable('users').set({ a: 1 }).returning(['id']);",
  ])('allows %s', async (code) => {
    expect(await lint(code)).toEqual([]);
  });

  // What the rule cannot see. Each is pinned so a change in reach shows up here; at run time the
  // database still refuses any of them for a role missing a column.
  it.each([
    ['a query passed in as a parameter', 'function f(q) { return q.selectAll(); }'],
    ['a template with a placeholder', 'tx.selectFrom(`${schema}.users`).selectAll();'],
    ['a table name held in a variable', "const t = 'users'; tx.selectFrom(t).selectAll();"],
    ['a computed method name', "tx.selectFrom('users')['selectAll']();"],
    ['a query returned by a helper', 'const q = base(); q.selectAll();'],
  ])('known limit: does not see %s', async (_name, code) => {
    expect(await lint(code)).toEqual([]);
  });

  // A table name is source text, so it can be hostile; reading it must stay linear.
  describe('with long runs of spaces in a table name', () => {
    const spaces = ' '.repeat(100_000);

    it('reads table, as and alias across them and refuses', async () => {
      const found = await lint(`tx.selectFrom('users${spaces}as u').selectAll('u');`);
      expect(found).toHaveLength(1);
    });

    it('allows a two word name and lints it in under 2 s', async () => {
      const started = performance.now();
      expect(await lint(`tx.selectFrom('users${spaces}x').selectAll('u');`)).toEqual([]);
      expect(performance.now() - started).toBeLessThan(2000);
    });
  });

  it('is on in the repository config for the controlled tables', async () => {
    const repo = new ESLint({ cwd: repoRoot });
    const config = (await repo.calculateConfigForFile(
      join(repoRoot, 'packages/auth/src/rate-limiter.ts'),
    )) as { rules?: Record<string, unknown> };
    expect(config.rules?.[RULE]).toEqual([
      2,
      {
        tables: [
          'users',
          'password_credentials',
          'known_devices',
          'totp_credentials',
          'recovery_codes',
          'factor_challenges',
        ],
      },
    ]);
  });
});

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
  ])('allows %s', async (code) => {
    expect(await lint(code)).toEqual([]);
  });

  it('is on in the repository config for users and password_credentials', async () => {
    const repo = new ESLint({ cwd: repoRoot });
    const config = (await repo.calculateConfigForFile(
      join(repoRoot, 'packages/auth/src/rate-limiter.ts'),
    )) as { rules?: Record<string, unknown> };
    expect(config.rules?.[RULE]).toEqual([2, { tables: ['users', 'password_credentials'] }]);
  });
});

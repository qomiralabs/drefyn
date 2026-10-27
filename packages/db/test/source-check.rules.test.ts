import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  namedQueryProblems,
  repoSourceProblems,
  tenantSettingProblems,
  transactionControlProblems,
} from '../src/source-check.ts';

// Assembled at run time: the repository scan reads this file too.
const SET_CONFIG = ['set', 'config'].join('_');
const SQL = 'sql';
const tag = (text: string) => `${SQL}\`${text}\`.execute(tx);`;
const NAME = ['na', 'me'].join('');

describe('tenant settings outside the context code', () => {
  it.each([
    [
      'set_config with true',
      `await ${SQL}\`select ${SET_CONFIG}('drefyn.organization_id', \${org}, true)\`.execute(tx);`,
    ],
    [
      'set_config with a parameter for is_local',
      `select ${SET_CONFIG}('drefyn.project_id', $1, $2)`,
    ],
    ['set_config with a name that is not a literal', `select ${SET_CONFIG}($1, $2, true)`],
    ['set local', `${['set', 'local'].join(' ')} drefyn.organization_id = 'x'`],
    ['a quoted name', `select ${SET_CONFIG}("drefyn.project_id", $1, true)`],
  ])('fails on %s in application code', (_label, text) => {
    expect(tenantSettingProblems('apps/api/src/handler.ts', text)).toHaveLength(1);
  });

  it.each([
    ['other settings', `select ${SET_CONFIG}('search_path', 'app', true)`],
    ['reads', "select current_setting('drefyn.organization_id', true)"],
    ['a lookalike', `my${SET_CONFIG}('drefyn.organization_id', x, true)`],
  ])('passes %s', (_label, text) => {
    expect(tenantSettingProblems('apps/api/src/handler.ts', text)).toEqual([]);
  });

  it.each(['packages/db/src/database.ts', 'packages/db/test/integration/x.test.ts'])(
    'leaves %s to its own review',
    (file) => {
      expect(
        tenantSettingProblems(file, `select ${SET_CONFIG}('drefyn.project_id', $1, true)`),
      ).toEqual([]);
    },
  );
});

describe('transaction control in raw SQL', () => {
  it.each([
    'begin',
    'COMMIT',
    ' rollback',
    'end',
    'abort',
    'start transaction',
    'set session statement_timeout = 0',
    'set statement_timeout = 0',
    '/* x */ commit',
  ])('fails on %j in a sql template', (text) => {
    const [problem] = transactionControlProblems('apps/api/src/a.ts', tag(text));
    expect(problem?.file).toBe('apps/api/src/a.ts');
    expect(problem?.line).toBe(1);
  });

  it('fails on sql.raw with a literal', () => {
    expect(transactionControlProblems('a.ts', `${SQL}.raw('commit')`)).toHaveLength(1);
    expect(transactionControlProblems('a.ts', `${SQL}.raw("begin")`)).toHaveLength(1);
  });

  it.each([
    'savepoint s1',
    'release savepoint s1',
    'rollback to savepoint s1',
    'set local statement_timeout = 100',
    'set constraints all deferred',
    'set transaction isolation level serializable',
    'select 1',
    'beginning',
  ])('passes %j', (text) => {
    expect(transactionControlProblems('apps/api/src/a.ts', tag(text))).toEqual([]);
  });

  it('leaves the db package and its tests to their own review', () => {
    expect(transactionControlProblems('packages/db/src/database.ts', tag('commit'))).toEqual([]);
    expect(transactionControlProblems('packages/db/test/x.test.ts', tag('commit'))).toEqual([]);
  });
});

describe('named queries', () => {
  it('fails on a query config with a name, which DISCARD ALL would deallocate', () => {
    const text = `await client.query({\n  ${NAME}: 'by-id',\n  text: 'select 1',\n});`;
    const [problem] = namedQueryProblems('apps/api/src/a.ts', text);
    expect(problem?.line).toBe(1);
  });

  it.each([
    `client.query({ text: 'select 1', values: [{ ${NAME}: 'x' }] })`,
    `client.query('select 1')`,
    `const entry = { ${NAME}: 'app.x', reason: 'y' };`,
    `client.query({ text: 'select 1'`,
  ])('passes %s', (text) => {
    expect(namedQueryProblems('a.ts', text)).toEqual([]);
  });
});

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the repository scan runs every rule', () => {
  it('reports each rule by file', () => {
    const root = mkdtempSync(join(tmpdir(), 'drefyn-db-rules-'));
    temps.push(root);
    const files: Record<string, string> = {
      'apps/a/src/tenant.ts': `${SQL}\`select ${SET_CONFIG}('drefyn.organization_id', $1, true)\``,
      'apps/a/src/commit.ts': tag('commit'),
      'apps/a/src/named.ts': `client.query({ ${NAME}: 'x', text: 'select 1' })`,
      'packages/db/src/database.ts': tag('commit'),
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'init', '-q'], { cwd: root });
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'add', '-A'], { cwd: root });
    expect(
      repoSourceProblems(root)
        .map((p) => p.file)
        .sort(),
    ).toEqual(['apps/a/src/commit.ts', 'apps/a/src/named.ts', 'apps/a/src/tenant.ts']);
  });
});

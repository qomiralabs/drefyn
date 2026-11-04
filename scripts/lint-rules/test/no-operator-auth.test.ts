import { join } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { makeEslint, repoRoot, reports } from './helpers.ts';

const RULE = 'drefyn/no-operator-auth';
const eslint = makeEslint(repoRoot, { [RULE]: 'error' });

async function lint(code: string) {
  const results = await eslint.lintText(code, { filePath: join(repoRoot, 'probe.ts') });
  return reports(results).filter((r) => r.ruleId === RULE);
}

describe('no-operator-auth', () => {
  it.each([
    ["import { issue } from '@drefyn/auth';", 'issue'],
    ["import { createOrganizationFor as make } from '@drefyn/auth';", 'createOrganizationFor'],
    ["export { issue } from '@drefyn/auth';", 'issue'],
    ['links.issue(input);', 'issue'],
    ['links?.issue(input);', 'issue'],
    ["links['issue'](input);", 'issue'],
    ['links[`issue`](input);', 'issue'],
    ['const send = links.issue;', 'issue'],
    ['organizations.createOrganizationFor(id, input);', 'createOrganizationFor'],
    ['auth().organizations.createOrganizationFor(id, input);', 'createOrganizationFor'],
    ['const { issue } = links;', 'issue'],
    ['const { createOrganizationFor: make } = organizations;', 'createOrganizationFor'],
    ["const { ['issue']: send } = links;", 'issue'],
  ])('refuses %s', async (code, name) => {
    const found = await lint(code);
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain(`'${name}'`);
  });

  it.each([
    "import { createCliLinks, createOrganizations } from '@drefyn/auth';",
    'links.redeem(browser, token);',
    'organizations.createOrganization(session, input);',
    "const mock = { createOrganizationFor: vi.fn(), issue: 'x' };",
    'const issue = 1; export { issue };',
    "import { issue } from './local.ts';",
    'links[name](input);',
  ])('allows %s', async (code) => {
    expect(await lint(code)).toEqual([]);
  });

  describe('in the configs', () => {
    const on = async (linter: ESLint, path: string) => {
      const config = (await linter.calculateConfigForFile(join(repoRoot, path))) as {
        rules?: Record<string, unknown>;
      };
      return config.rules?.[RULE];
    };
    const guard = new ESLint({
      cwd: repoRoot,
      overrideConfigFile: join(repoRoot, 'scripts/lint-rules/guard.config.js'),
    });

    it.each([
      ['the root config', new ESLint({ cwd: repoRoot })],
      ['the guard', guard],
    ])('%s holds it for apps and leaves packages alone', async (_name, linter) => {
      expect(await on(linter, 'apps/dashboard/src/server/auth.ts')).toEqual([2]);
      expect(await on(linter, 'packages/auth/src/command.ts')).toBeUndefined();
    });
  });
});

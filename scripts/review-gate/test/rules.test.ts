import { describe, expect, it } from 'vitest';
import { classify, requiredReviewers } from '../src/gate.ts';
import { DEFAULT_CONFIG_PATH, loadConfig, parseConfig } from '../src/rules.ts';

const matcher = {
  prefixes: ['.github/'],
  names: ['package.json'],
  contains: ['auth'],
  suffixes: [],
};
const empty = { prefixes: [], names: [], contains: [], suffixes: [] };
const paths = { security: matcher, tests: empty, ui: empty, docs: { ...empty, suffixes: ['.md'] } };
const reviewers = { 'code-reviewer': ['alice'], 'qa-verifier': ['alice', 'qa-bot'] };

describe('parseConfig', () => {
  it('reads the path matchers and the reviewer allow list', () => {
    expect(parseConfig({ reviewers, paths })).toEqual({ paths, reviewers });
  });

  it('accepts an empty login list, which then fails closed if that reviewer is required', () => {
    expect(parseConfig({ reviewers: { 'design-reviewer': [] }, paths }).reviewers).toEqual({
      'design-reviewer': [],
    });
  });

  it.each([
    ['not an object', 'nope'],
    ['null', null],
    ['paths missing', { reviewers }],
    ['the old rules list', { reviewers, paths, rules: [] }],
    ['an unknown top level key', { reviewers, paths, extra: true }],
    ['paths not an object', { reviewers, paths: [] }],
    ['a class missing', { reviewers, paths: { security: matcher, tests: empty, ui: empty } }],
    ['an unknown class', { reviewers, paths: { ...paths, infra: empty } }],
    ['a class that is not an object', { reviewers, paths: { ...paths, ui: 'apps/' } }],
    [
      'a matcher field missing',
      {
        reviewers,
        paths: { ...paths, ui: { prefixes: [], names: [], contains: [] } },
      },
    ],
    // A typo such as "prefix" would otherwise match nothing and quietly lower the tier.
    [
      'a misspelled matcher field',
      { reviewers, paths: { ...paths, security: { ...matcher, prefix: ['deploy/'] } } },
    ],
    [
      'prefixes not a list',
      { reviewers, paths: { ...paths, security: { ...matcher, prefixes: '.github/' } } },
    ],
    [
      'an empty pattern',
      { reviewers, paths: { ...paths, security: { ...matcher, contains: [''] } } },
    ],
    [
      'a wildcard inside a path segment',
      { reviewers, paths: { ...paths, tests: { ...empty, prefixes: ['packages/a*/test/'] } } },
    ],
    ['the old dirs field', { reviewers, paths: { ...paths, tests: { ...empty, dirs: ['test'] } } }],
    ['reviewers missing', { paths }],
    ['reviewers not a map', { reviewers: ['alice'], paths }],
    [
      'hygiene-auditor, which is no longer a reviewer',
      { reviewers: { 'hygiene-auditor': ['alice'] }, paths },
    ],
    ['unknown reviewer name in the allow list', { reviewers: { friend: ['alice'] }, paths }],
    ['logins not a list', { reviewers: { 'code-reviewer': 'alice' }, paths }],
    ['an empty login', { reviewers: { 'code-reviewer': [''] }, paths }],
    ['a login with a space', { reviewers: { 'code-reviewer': ['a b'] }, paths }],
    // GraphQL reports app logins without the suffix, so such an entry could never match.
    ['a login with a [bot] suffix', { reviewers: { 'code-reviewer': ['renovate[bot]'] }, paths }],
  ])('rejects %s', (_name, raw) => {
    expect(() => parseConfig(raw)).toThrow(/invalid rules/);
  });
});

describe('the shipped rules file', () => {
  const config = loadConfig(DEFAULT_CONFIG_PATH);
  const tier = (file: string) => classify(file, config.paths).tier;
  const reviewersFor = (files: string[]) =>
    requiredReviewers([], files, config.paths).map((r) => r.reviewer);

  it('names an allowed login for every reviewer and nothing for hygiene-auditor', () => {
    expect(Object.keys(config.reviewers).sort()).toEqual([
      'code-reviewer',
      'design-reviewer',
      'performance-reviewer',
      'qa-verifier',
      'security-reviewer',
    ]);
    for (const logins of Object.values(config.reviewers)) expect(logins).toEqual(['Divine572']);
  });

  it.each([
    '.github/workflows/ci.yml',
    '.github/CODEOWNERS',
    '.github/pull_request_template.md',
    '.github/ISSUE_TEMPLATE/task.md',
    'scripts/gate.sh',
    'scripts/precommit.sh',
    'scripts/selfhost.sh',
    'scripts/review-gate/rules.json',
    'scripts/review-gate/test/gate.test.ts',
    'scripts/hygiene/README.md',
    'scripts/lint-rules/test/fixtures/boundaries/apps/site/src/index.ts',
    'deploy/compose.yaml',
    'deploy/README.md',
    'docker/api/Dockerfile',
    'apps/website/Dockerfile',
    '.dockerignore',
    '.changeset/brave-cats.md',
    'renovate.json',
    'package.json',
    'packages/core/package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'SECURITY.md',
    '.npmrc',
    '.nvmrc',
    '.pnpmfile.cjs',
    'turbo.json',
    'tsconfig.json',
    'tsconfig.base.json',
    'packages/core/tsconfig.build.json',
    'eslint.config.js',
    'packages/web/src/sub/eslint.config.js',
    'packages/web/eslint.config.mjs',
    'apps/site/src/eslint.config.cjs',
    'eslint.config.ts',
    'packages/web/src/eslint.config.mts',
    'packages/web/src/eslint.config.cts',
    'scripts/lint-rules/guard.config.js',
    'packages/egress/src/index.ts',
    'packages/db/migrations/0001_init.up.sql',
    'packages/db/migrations/1760000000000_x.sql',
    'packages/db/migrations/test/0001.test.ts',
    'packages/egress/package.json',
    'packages/web/src/pnpm-workspace.yaml',
    '.gitmodules',
    '.gitignore',
    'LICENSE',
    '.gitattributes',
    'packages/web/.gitattributes',
    'vitest.shared.ts',
    'packages/core/vitest.config.ts',
    '.gitleaks.toml',
    '.gitleaksignore',
    'osv-scanner.toml',
    '.trivyignore',
    '.semgrepignore',
    'CODEOWNERS',
    'docs/CODEOWNERS',
    '.husky/pre-commit',
    '.githooks/pre-push',
    'dockerfile',
    'DOCKERFILE',
    'apps/web/Dockerfile.prod',
    'deploy-less/api.Dockerfile',
    'compose.yaml',
    'compose.yml',
    'apps/web/compose.override.yml',
    'docker-compose.yml',
    'tools/docker-compose.dev.yaml',
    'infra/main.tf',
    'modules/vpc/variables.tf',
    'envs/prod.tfvars',
    'apps/web/vitest.config.mts',
    'scripts/hygiene/vitest.config.ts',
    '.prettierrc.json',
    '.prettierignore',
    'packages/auth/src/session.ts',
    'packages/auth/test/session.test.ts',
    'packages/auth/README.md',
    'apps/cloud/src/tenancy/rls.sql',
    'packages/tenancy/src/ids.ts',
    'packages/billing/src/invoice.ts',
    'packages/credits/src/ledger.ts',
    'packages/entitlements/src/plans.ts',
    'packages/engine/src/publish/gate.ts',
    'apps/studio/src/PublishButton.tsx',
    'packages/flags/src/client.ts',
    'packages/flags/test/evaluation.test.ts',
    'packages/flags/README.md',
  ])('puts %s in tier A', (file) => {
    expect(tier(file)).toBe('A');
    expect(reviewersFor([file])).toEqual(
      expect.arrayContaining(['code-reviewer', 'qa-verifier', 'security-reviewer']),
    );
  });

  it.each([
    ['packages/engine/src/index.ts', false],
    ['packages/status/src/agree.ts', false],
    ['packages/probe/src/http.ts', false],
    ['templates/package/src/index.ts', false],
    ['packages/egress-old/src/index.ts', false],
    ['packages/db/migrations-old/x.sql', false],
    ['packages/flags-old/src/index.ts', false],
    ['packages/ui/src/tokens.ts', true],
    ['packages/ui/README.md', true],
    ['packages/email/src/welcome.ts', true],
    ['packages/editor/src/toolbar.ts', true],
    ['packages/site/src/layout.ts', true],
    ['apps/dashboard/src/routes/home.ts', true],
    ['apps/docs-site/src/page.ts', true],
    ['apps/status-page/src/index.ts', true],
    ['apps/website/content/pricing.md', true],
    ['apps/website/content/pricing.mdx', true],
    ['packages/engine/src/render/Badge.tsx', true],
    ['packages/engine/src/theme.css', true],
    ['packages/engine/assets/logo.svg', true],
    ['apps/web/app/test/page.tsx', true],
    ['packages/monitors/src/tests/http.ts', false],
    ['apps/status/src/e2e/probe.ts', true],
    ['apps/dashboard/src/__tests__/home.tsx', true],
    ['packages/core/src/test/helpers.ts', false],
    ['docs/guide.txt', false],
    ['docs/guide.mdx', true],
  ])('puts %s in tier B (design reviewer %s)', (file, ui) => {
    expect(classify(file, config.paths)).toEqual({ tier: 'B', ui });
    const expected = ['code-reviewer', 'qa-verifier', ...(ui ? ['design-reviewer'] : [])];
    expect(reviewersFor([file])).toEqual(expected);
  });

  it.each([
    'README.md',
    'CONTRIBUTING.md',
    'CODE_OF_CONDUCT.md',
    'docs/guide.md',
    'templates/package/README.md',
    'packages/engine/README.md',
    'packages/engine/CHANGELOG.md',
    'packages/engine/test/render.test.ts',
    'packages/engine/src/render.test.ts',
    'packages/engine/src/render.spec.ts',
    'packages/engine/test/types/api.test-d.ts',
    'packages/engine/test/fixtures/repo.json',
    'packages/ui/src/Button.test.tsx',
    'apps/dashboard/e2e/login.spec.ts',
    'templates/package/test/index.test.ts',
    'packages/monitors/tests/http.ts',
    'packages/engine/__tests__/render.ts',
    'apps/dashboard/e2e/login.ts',
    'apps/web/app/page.test.tsx',
    'apps/web/test/setup.ts',
  ])('puts %s in tier C', (file) => {
    expect(tier(file)).toBe('C');
    expect(reviewersFor([file])).toEqual(['code-reviewer']);
  });
});

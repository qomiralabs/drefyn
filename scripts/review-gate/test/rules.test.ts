import { describe, expect, it } from 'vitest';
import { requiredReviewers } from '../src/gate.ts';
import { DEFAULT_CONFIG_PATH, loadConfig, parseConfig } from '../src/rules.ts';

const rule = {
  reviewer: 'security-reviewer',
  prefixes: ['.github/'],
  names: ['package.json'],
  contains: ['auth'],
};
const reviewers = { 'code-reviewer': ['alice'], 'qa-verifier': ['alice', 'qa-bot'] };

describe('parseConfig', () => {
  it('reads path rules and the reviewer allow list', () => {
    expect(parseConfig({ reviewers, rules: [rule] })).toEqual({ paths: [rule], reviewers });
  });

  it('accepts an empty login list, which then fails closed if that reviewer is required', () => {
    expect(parseConfig({ reviewers: { 'design-reviewer': [] }, rules: [] }).reviewers).toEqual({
      'design-reviewer': [],
    });
  });

  it.each([
    ['not an object', 'nope'],
    ['rules missing', { reviewers }],
    ['rules not a list', { reviewers, rules: {} }],
    ['unknown reviewer in a rule', { reviewers, rules: [{ ...rule, reviewer: 'friend' }] }],
    ['prefixes not a list', { reviewers, rules: [{ ...rule, prefixes: '.github/' }] }],
    ['empty pattern', { reviewers, rules: [{ ...rule, contains: [''] }] }],
    [
      'names missing',
      { reviewers, rules: [{ reviewer: rule.reviewer, prefixes: [], contains: [] }] },
    ],
    ['reviewers missing', { rules: [] }],
    ['reviewers not a map', { reviewers: ['alice'], rules: [] }],
    ['unknown reviewer name in the allow list', { reviewers: { friend: ['alice'] }, rules: [] }],
    ['logins not a list', { reviewers: { 'code-reviewer': 'alice' }, rules: [] }],
    ['an empty login', { reviewers: { 'code-reviewer': [''] }, rules: [] }],
    ['a login with a space', { reviewers: { 'code-reviewer': ['a b'] }, rules: [] }],
    // GraphQL reports app logins without the suffix, so such an entry could never match.
    [
      'a login with a [bot] suffix',
      { reviewers: { 'code-reviewer': ['renovate[bot]'] }, rules: [] },
    ],
  ])('rejects %s', (_name, raw) => {
    expect(() => parseConfig(raw)).toThrow(/invalid rules/);
  });
});

describe('the shipped rules file', () => {
  const config = loadConfig(DEFAULT_CONFIG_PATH);
  const needsSecurity = (file: string) =>
    requiredReviewers([], [file], config.paths).some((r) => r.reviewer === 'security-reviewer');

  it('names an allowed login for every reviewer', () => {
    for (const reviewer of [
      'code-reviewer',
      'qa-verifier',
      'hygiene-auditor',
      'security-reviewer',
      'performance-reviewer',
      'design-reviewer',
    ]) {
      expect(config.reviewers[reviewer]).toEqual(['Divine572']);
    }
  });

  it.each([
    '.github/workflows/ci.yml',
    '.github/CODEOWNERS',
    'scripts/gate.sh',
    'scripts/precommit.sh',
    'scripts/review-gate/rules.json',
    'deploy/compose.yaml',
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
    'packages/egress/package.json',
    'packages/web/src/pnpm-workspace.yaml',
    '.gitmodules',
    '.gitignore',
    'LICENSE',
    '.gitattributes',
    'packages/web/.gitattributes',
    'vitest.shared.ts',
    '.prettierrc.json',
    '.prettierignore',
    'packages/auth/src/session.ts',
    'apps/cloud/src/tenancy/rls.sql',
    'packages/billing/src/invoice.ts',
    'packages/credits/src/ledger.ts',
    'packages/entitlements/src/plans.ts',
  ])('requires the security reviewer for %s', (file) => {
    expect(needsSecurity(file)).toBe(true);
  });

  it.each([
    'README.md',
    'docs/guide.md',
    'apps/web/src/page.tsx',
    'CONTRIBUTING.md',
    'packages/egress-old/src/index.ts',
  ])('does not require it for %s', (file) => {
    expect(needsSecurity(file)).toBe(false);
  });
});

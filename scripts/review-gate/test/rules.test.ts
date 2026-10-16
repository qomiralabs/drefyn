import { describe, expect, it } from 'vitest';
import { requiredReviewers } from '../src/gate.ts';
import { DEFAULT_RULES_PATH, loadRules, parseRules } from '../src/rules.ts';

const rule = {
  reviewer: 'security-reviewer',
  prefixes: ['.github/'],
  names: ['package.json'],
  contains: ['auth'],
};

describe('parseRules', () => {
  it('reads a valid rules file', () => {
    expect(parseRules({ rules: [rule] })).toEqual([rule]);
  });

  it.each([
    ['not an object', 'nope'],
    ['rules missing', {}],
    ['rules not a list', { rules: {} }],
    ['unknown reviewer', { rules: [{ ...rule, reviewer: 'friend' }] }],
    ['prefixes not a list', { rules: [{ ...rule, prefixes: '.github/' }] }],
    ['empty pattern', { rules: [{ ...rule, contains: [''] }] }],
    ['names missing', { rules: [{ reviewer: rule.reviewer, prefixes: [], contains: [] }] }],
  ])('rejects %s', (_name, raw) => {
    expect(() => parseRules(raw)).toThrow(/invalid rules/);
  });
});

describe('the shipped rules file', () => {
  const rules = loadRules(DEFAULT_RULES_PATH);
  const needsSecurity = (file: string) =>
    requiredReviewers([], [file], rules).some((r) => r.reviewer === 'security-reviewer');

  it.each([
    '.github/workflows/ci.yml',
    '.github/CODEOWNERS',
    'scripts/gate.sh',
    'scripts/review-gate/rules.json',
    'deploy/compose.yaml',
    'renovate.json',
    'package.json',
    'packages/core/package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'SECURITY.md',
    'packages/auth/src/session.ts',
    'apps/cloud/src/tenancy/rls.sql',
    'packages/billing/src/invoice.ts',
    'packages/credits/src/ledger.ts',
    'packages/entitlements/src/plans.ts',
  ])('requires the security reviewer for %s', (file) => {
    expect(needsSecurity(file)).toBe(true);
  });

  it.each(['README.md', 'docs/guide.md', 'apps/web/src/page.tsx', 'CONTRIBUTING.md'])(
    'does not require it for %s',
    (file) => {
      expect(needsSecurity(file)).toBe(false);
    },
  );
});

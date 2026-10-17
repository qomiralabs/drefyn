// @ts-check
import js from '@eslint/js';
import drefyn from '@drefyn/lint-rules';
import tseslint from 'typescript-eslint';

// Each entry lets one file or directory open raw network connections. They bypass the
// SSRF guard, so every entry needs a security review and a reason that says why the
// destination cannot be influenced by a customer.
const egressAllowList = [
  {
    path: 'scripts/review-gate/src/github.ts',
    reason:
      'GitHub API client for the review gate in CI; the host is api.github.com or GITHUB_API_URL from the Actions runner, never customer input',
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/coverage/**',
      '**/dist/**',
      '**/.turbo/**',
      // Broken on purpose: the lint rule tests run ESLint on them with their own config.
      'scripts/lint-rules/test/fixtures/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    plugins: { drefyn },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'drefyn/no-cross-package-internals': 'error',
      'drefyn/no-raw-egress': ['error', { allow: egressAllowList }],
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);

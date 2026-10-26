// @ts-check
import js from '@eslint/js';
import drefyn, { egressAllowList } from '@drefyn/lint-rules';
import tseslint from 'typescript-eslint';

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
    // Everything people see is styled from tokens only.
    files: ['packages/ui/**', 'apps/**'],
    rules: { 'drefyn/no-arbitrary-values': 'error' },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);

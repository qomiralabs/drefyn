// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import drefyn from './scripts/lint-rules/src/index.ts';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/coverage/**',
      '**/dist/**',
      '**/.turbo/**',
      // Lint fixtures are read by their tests with their own config.
      '**/test/fixtures/**',
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
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    // Everything people see is styled from tokens only.
    files: ['packages/ui/**', 'apps/**'],
    plugins: { drefyn },
    rules: { 'drefyn/no-arbitrary-values': 'error' },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);

// @ts-check
import js from '@eslint/js';
import drefyn, { egressAllowList } from '@drefyn/lint-rules';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const motionMessage =
  'Motion runs only in the dashboard and website. Use the duration and ease tokens.';
// Dynamic imports are how Motion's features get lazy loaded, and no-restricted-imports
// does not see them.
const dynamicMotion = {
  selector: 'ImportExpression[source.value=/^(framer-)?motion($|\\u002F)/]',
  message: motionMessage,
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/coverage/**',
      '**/dist/**',
      '**/.turbo/**',
      '**/storybook-static/**',
      '**/test-results/**',
      '**/playwright-report/**',
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
    files: ['packages/ui/**', 'apps/**'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    // Components only render text and style from token utilities, so nothing a
    // customer typed can become markup and no value skips the token lint.
    files: ['packages/ui/src/react/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='style']",
          message: 'Style from token utilities, not inline styles.',
        },
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'Components render text, never raw HTML.',
        },
        dynamicMotion,
      ],
    },
  },
  {
    // Docs sites and status pages must never load Motion; components animate with CSS.
    ignores: ['apps/dashboard/**', 'apps/website/**', 'packages/ui/src/react/**'],
    rules: { 'no-restricted-syntax': ['error', dynamicMotion] },
  },
  {
    ignores: ['apps/dashboard/**', 'apps/website/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['motion', 'motion/*', 'framer-motion', 'framer-motion/*'],
              message: motionMessage,
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);

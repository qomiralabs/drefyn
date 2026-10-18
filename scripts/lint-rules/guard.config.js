// @ts-check
// Config for the guard step only. It holds nothing but the two boundary rules and a
// parser, and is passed with config lookup, inline config and ignores all off, so no
// file, comment or package script in the tree can turn the rules off for itself.
import process from 'node:process';
import tseslint from 'typescript-eslint';
import drefyn, { egressAllowList } from './src/index.ts';

export default [
  {
    files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    languageOptions: { parser: tseslint.parser },
    // guard.sh runs from the git top level. Pinning the root there means a nested
    // pnpm-workspace.yaml cannot move it and mint a packages/egress of its own.
    settings: { drefyn: { workspaceRoot: process.cwd() } },
    plugins: { drefyn },
    rules: {
      'drefyn/no-cross-package-internals': 'error',
      'drefyn/no-raw-egress': ['error', { allow: egressAllowList }],
    },
  },
  {
    files: ['**/*.{jsx,tsx}'],
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
  },
  {
    files: ['**/*.cjs', '**/*.cts'],
    languageOptions: { sourceType: 'commonjs' },
  },
];

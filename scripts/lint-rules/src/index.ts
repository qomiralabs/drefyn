import type { ESLint } from 'eslint';
import { noCrossPackageInternals } from './no-cross-package-internals.ts';

const plugin = {
  meta: { name: '@drefyn/lint-rules' },
  rules: {
    'no-cross-package-internals': noCrossPackageInternals,
  },
} satisfies ESLint.Plugin;

export default plugin;

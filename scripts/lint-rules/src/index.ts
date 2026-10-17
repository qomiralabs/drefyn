import type { ESLint } from 'eslint';
import { noCrossPackageInternals } from './no-cross-package-internals.ts';
import { noRawEgress } from './no-raw-egress.ts';

const plugin = {
  meta: { name: '@drefyn/lint-rules' },
  rules: {
    'no-cross-package-internals': noCrossPackageInternals,
    'no-raw-egress': noRawEgress,
  },
} satisfies ESLint.Plugin;

export default plugin;

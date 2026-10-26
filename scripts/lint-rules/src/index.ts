import type { ESLint } from 'eslint';
import { noArbitraryValues } from './no-arbitrary-values.ts';
import { noCrossPackageInternals } from './no-cross-package-internals.ts';
import { noRawEgress } from './no-raw-egress.ts';

export { egressAllowList } from './egress-allow-list.ts';
export { classify, noArbitraryValues, type Problem } from './no-arbitrary-values.ts';

const plugin = {
  meta: { name: '@drefyn/lint-rules' },
  rules: {
    'no-arbitrary-values': noArbitraryValues,
    'no-cross-package-internals': noCrossPackageInternals,
    'no-raw-egress': noRawEgress,
  },
} satisfies ESLint.Plugin;

export default plugin;

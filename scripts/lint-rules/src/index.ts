import type { ESLint } from 'eslint';
import { noArbitraryValues } from './no-arbitrary-values.ts';
import { noCrossPackageInternals } from './no-cross-package-internals.ts';
import { noMdxEvaluate } from './no-mdx-evaluate.ts';
import { noOperatorAuth } from './no-operator-auth.ts';
import { noRawEgress } from './no-raw-egress.ts';
import { noSelectAll } from './no-select-all.ts';
import { noTierLiterals } from './no-tier-literals.ts';

export {
  allowListProblems,
  type EgressAllowance,
  type EgressAllowEntry,
} from './egress-allow-entry.ts';
export { egressAllowList } from './egress-allow-list.ts';
export { classify, noArbitraryValues, type Problem } from './no-arbitrary-values.ts';

const plugin = {
  meta: { name: '@drefyn/lint-rules' },
  rules: {
    'no-arbitrary-values': noArbitraryValues,
    'no-cross-package-internals': noCrossPackageInternals,
    'no-mdx-evaluate': noMdxEvaluate,
    'no-operator-auth': noOperatorAuth,
    'no-raw-egress': noRawEgress,
    'no-select-all': noSelectAll,
    'no-tier-literals': noTierLiterals,
  },
} satisfies ESLint.Plugin;

export default plugin;

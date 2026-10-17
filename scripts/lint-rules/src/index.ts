import type { ESLint } from 'eslint';
import { noArbitraryValues } from './no-arbitrary-values.ts';

export { classify, noArbitraryValues, type Problem } from './no-arbitrary-values.ts';

const plugin = {
  meta: { name: '@drefyn/lint-rules' },
  rules: { 'no-arbitrary-values': noArbitraryValues },
} satisfies ESLint.Plugin;

export default plugin;

import type { Rule } from 'eslint';
import { moduleReferences } from './references.ts';

// Every export of these packages either compiles MDX to JavaScript or runs it, and MDX is a
// programming language: one export in a customer page reads process.env. A type only import
// loads nothing, so it passes. A require made by createRequire is out of this rule's reach.
const BANNED = [
  '@mdx-js/mdx',
  '@mdx-js/node-loader',
  '@mdx-js/loader',
  '@mdx-js/esbuild',
  '@mdx-js/rollup',
];

const isBanned = (spec: string) =>
  BANNED.some((name) => spec === name || spec.startsWith(`${name}/`));

export const noMdxEvaluate: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Customer MDX is parsed, never compiled or run' },
    schema: [],
    messages: {
      banned:
        "Customer MDX is never compiled or run. '{{spec}}' turns it into code; parse with @drefyn/mdx.",
    },
  },
  create(context) {
    return moduleReferences(({ spec, loc, typeOnly }) => {
      if (!typeOnly && isBanned(spec)) {
        context.report({ loc, messageId: 'banned', data: { spec } });
      }
    });
  },
};

import type { Rule } from 'eslint';
import { literal } from './references.ts';
import { isRecord } from './workspace.ts';

// CliLinks.issue mints a sign in link for anyone, and Organizations.createOrganizationFor acts
// for a bare user id with no session. Both are for the operator command. They sit on objects
// apps legitimately hold, so the factories stay importable and the names are refused instead.
// Matching by name means an unrelated method called issue must be renamed under apps/; a check
// tied to the import would miss the object once it crosses a file.
const OPERATOR_ONLY = new Set(['issue', 'createOrganizationFor']);

function keyName(key: unknown, computed: boolean): string | undefined {
  if (computed) return literal(key)?.spec;
  if (!isRecord(key)) return undefined;
  return typeof key['name'] === 'string' ? key['name'] : literal(key)?.spec;
}

const isAuth = (source: unknown) =>
  isRecord(source) && typeof source['value'] === 'string'
    ? source['value'] === '@drefyn/auth' || source['value'].startsWith('@drefyn/auth/')
    : false;

export const noOperatorAuth: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Keep the operator only auth calls out of apps' },
    schema: [],
    messages: {
      operator: "'{{name}}' is for the operator command only. No app may reach it.",
    },
  },
  create(context) {
    const check = (name: string | undefined, node: Rule.Node) => {
      if (name !== undefined && OPERATOR_ONLY.has(name)) {
        context.report({ node, messageId: 'operator', data: { name } });
      }
    };
    return {
      ImportSpecifier: (node) => {
        const parent: unknown = node.parent;
        if (isRecord(parent) && isAuth(parent['source'])) {
          check(keyName(node.imported, false), node);
        }
      },
      ExportSpecifier: (node) => {
        if (isRecord(node.parent) && isAuth(node.parent['source'])) {
          check(keyName(node.local, false), node);
        }
      },
      MemberExpression: (node) => {
        check(keyName(node.property, node.computed), node);
      },
      'ObjectPattern > Property': (node: Rule.Node) => {
        if (node.type === 'Property') check(keyName(node.key, node.computed), node);
      },
    };
  },
};

import type { Rule } from 'eslint';
import { cachedWorkspace, isRecord, ownerOf, workspaceRootFor } from './workspace.ts';

// A hard coded plan check passes every test until the plans change, and then one product
// silently disagrees with the others. Each form below decides something by plan name, so it
// belongs in the entitlements table. Names built at run time or held in a variable are out of
// reach: this guards against honest mistakes, not evasion.
//
// Kept apart from TIERS in @drefyn/entitlements on purpose: the root config loads this
// package, and lint tooling should not depend on the product code it checks.
const TIERS: ReadonlySet<unknown> = new Set([
  'free',
  'starter',
  'growth',
  'scale',
  'enterprise',
  'self_hosted',
]);

const EQUALITY = new Set(['==', '===', '!=', '!==']);
const LOOKUPS = new Set(['includes', 'indexOf']);
// `as const` is how a literal list is usually written, and it changes nothing at run time.
const TRANSPARENT = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression']);

interface AstNode {
  readonly type: string;
  readonly expression?: unknown;
  readonly elements?: unknown;
}

const unwrapped = (node: AstNode): AstNode =>
  TRANSPARENT.has(node.type) ? unwrapped(node.expression as AstNode) : node;

// Template literals stay out: they are how copy is written, and `free` is an English word.
const isTierLiteral = (node: unknown): boolean =>
  isRecord(node) && node['type'] === 'Literal' && TIERS.has(node['value']);

// Asks the workspace, not the path from cwd: each package lints from its own folder.
function inEntitlements(file: string, settings: unknown): boolean {
  const root = workspaceRootFor(file, settings);
  if (root === undefined) return false;
  return ownerOf(cachedWorkspace(root), file)?.name === '@drefyn/entitlements';
}

export const noTierLiterals: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Plan decisions read @drefyn/entitlements, never a tier name' },
    schema: [],
    messages: {
      literal:
        'Hard coded plan check. Read @drefyn/entitlements (hasFeature, checkLimit or limitFor), so a plan change reaches every product.',
    },
  },
  create(context) {
    if (inEntitlements(context.filename, context.settings)) return {};
    return {
      BinaryExpression(node) {
        if (!EQUALITY.has(node.operator)) return;
        if (isTierLiteral(node.left) || isTierLiteral(node.right)) {
          context.report({ node, messageId: 'literal' });
        }
      },
      SwitchCase(node) {
        if (isTierLiteral(node.test)) context.report({ node, messageId: 'literal' });
      },
      CallExpression(node) {
        const { callee } = node;
        if (callee.type !== 'MemberExpression' || callee.computed) return;
        if (callee.property.type !== 'Identifier' || !LOOKUPS.has(callee.property.name)) return;
        const { elements } = unwrapped(callee.object);
        if (Array.isArray(elements) && elements.some(isTierLiteral)) {
          context.report({ node, messageId: 'literal' });
        }
      },
      ObjectExpression(node) {
        const keyed = node.properties.filter((property) => {
          if (property.type !== 'Property') return false;
          const { computed, key } = property;
          if (!computed && key.type === 'Identifier') return TIERS.has(key.name);
          return isTierLiteral(key);
        });
        if (keyed.length >= 2) {
          context.report({ node, messageId: 'literal' });
        }
      },
    };
  },
};

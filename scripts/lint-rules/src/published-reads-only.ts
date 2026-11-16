import type { Rule } from 'eslint';
import { literal } from './references.ts';
import { isRecord } from './workspace.ts';

// Code that serves the public: the docs and status sites, the website and the public routes of
// the API. It reads through the published reader alone, whose role has no grant on a draft
// table, so nothing here may even hold a handle that could.
export const PUBLIC_PATHS: readonly string[] = [
  'apps/docs-site/**',
  'apps/status-page/**',
  'apps/website/**',
  'apps/api/src/public/**',
];

// The runtime names a public path may import from each guarded module. A list of what is
// allowed, not what is refused, so a new draft read is refused before anyone thinks of it.
// Type only imports are free: they load nothing.
const ALLOWED: Readonly<Record<string, ReadonlySet<string>>> = {
  '@drefyn/db': new Set([
    'createPublishedDatabase',
    'parsePublishedReaderConfig',
    'withPublishedReader',
    'closeDatabase',
    'DbError',
  ]),
  '@drefyn/engine': new Set(['createPublishedReader', 'publishedStore']),
  kysely: new Set(['sql']),
  // A raw driver could open any connection string, so none of these is allowed at all.
  pg: new Set(),
  'pg-pool': new Set(),
  postgres: new Set(),
};

// The module a specifier is guarded under and whether it is the root, or undefined.
function guarded(spec: string): { module: string; root: boolean } | undefined {
  for (const module of Object.keys(ALLOWED)) {
    if (spec === module) return { module, root: true };
    if (spec.startsWith(`${module}/`)) return { module, root: false };
  }
  return undefined;
}

const nameOf = (node: unknown): string | undefined => {
  if (!isRecord(node)) return undefined;
  if (typeof node['name'] === 'string') return node['name'];
  return literal(node)?.spec;
};

const isType = (node: unknown, key: string) => isRecord(node) && node[key] === 'type';

export const publishedReadsOnly: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Public paths read published content only' },
    schema: [],
    messages: {
      name: "'{{name}}' from '{{module}}' can reach drafts. Public paths read through createPublishedReader only.",
      module:
        "'{{module}}' can reach drafts. Public paths import only the published reader's names from it.",
    },
  },
  create(context) {
    const whole = (node: Rule.Node, spec: string) => {
      context.report({ node, messageId: 'module', data: { module: spec } });
    };
    // A named import or re-export: allowed by name from the root of a guarded module only.
    const named = (
      node: Rule.Node,
      source: unknown,
      typeOnly: boolean,
      specifiers: readonly unknown[],
      pick: (specifier: Record<string, unknown>) => unknown,
    ) => {
      const spec = literal(source)?.spec;
      const found = spec === undefined ? undefined : guarded(spec);
      if (spec === undefined || found === undefined || typeOnly) return;
      if (!found.root || specifiers.length === 0) {
        whole(node, spec);
        return;
      }
      const allowed = ALLOWED[found.module] ?? new Set<string>();
      for (const specifier of specifiers) {
        if (!isRecord(specifier)) continue;
        if (isType(specifier, 'importKind') || isType(specifier, 'exportKind')) continue;
        const kind = specifier['type'];
        const name =
          kind === 'ImportSpecifier' || kind === 'ExportSpecifier'
            ? nameOf(pick(specifier))
            : undefined;
        if (name !== undefined && allowed.has(name)) continue;
        context.report({
          node: specifier as unknown as Rule.Node,
          messageId: name === undefined ? 'module' : 'name',
          data: { module: spec, name: name ?? '' },
        });
      }
    };
    const loaded = (node: Rule.Node, source: unknown) => {
      const spec = literal(source)?.spec;
      if (spec !== undefined && guarded(spec) !== undefined) whole(node, spec);
    };
    return {
      ImportDeclaration: (node) => {
        named(
          node,
          node.source,
          isType(node, 'importKind'),
          node.specifiers,
          (specifier) => specifier['imported'],
        );
      },
      ExportNamedDeclaration: (node) => {
        if (node.source === null || node.source === undefined) return;
        named(
          node,
          node.source,
          isType(node, 'exportKind'),
          node.specifiers,
          (specifier) => specifier['local'],
        );
      },
      ExportAllDeclaration: (node) => {
        if (!isType(node, 'exportKind')) loaded(node, node.source);
      },
      ImportExpression: (node) => {
        loaded(node, node.source);
      },
      CallExpression: (node) => {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
          loaded(node, node.arguments[0]);
        }
      },
      TSImportEqualsDeclaration: (node: Rule.Node) => {
        const raw: unknown = node;
        if (!isRecord(raw) || isType(raw, 'importKind') || !isRecord(raw['moduleReference'])) {
          return;
        }
        if (raw['moduleReference']['type'] !== 'TSExternalModuleReference') return;
        loaded(node, raw['moduleReference']['expression']);
      },
    };
  },
};

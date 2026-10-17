import { dirname, isAbsolute, relative, sep } from 'node:path';
import type { AST, Rule, Scope } from 'eslint';
import { moduleReferences } from './references.ts';
import { cachedWorkspace, findWorkspaceRoot, isRecord, ownerOf } from './workspace.ts';

// Each of these can open a socket or resolve a name without the guard. http2 is listed
// because it reaches the same hosts as http and https.
const BANNED_BUILTINS = new Set([
  'http',
  'https',
  'http2',
  'net',
  'tls',
  'dgram',
  'dns',
  'dns/promises',
]);
const GLOBAL_APIS = new Set(['fetch', 'WebSocket']);
const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self', 'global']);
const EGRESS_PACKAGE = 'packages/egress/';

interface AllowEntry {
  path: string;
  reason: string;
}

function isBannedModule(spec: string): boolean {
  if (spec.startsWith('node:')) return BANNED_BUILTINS.has(spec.slice('node:'.length));
  return BANNED_BUILTINS.has(spec) || spec === 'undici' || spec.startsWith('undici/');
}

function isAllowed(rel: string, allow: readonly AllowEntry[]): boolean {
  if (rel.startsWith(EGRESS_PACKAGE)) return true;
  return allow.some((entry) =>
    entry.path.endsWith('/') ? rel.startsWith(entry.path) : rel === entry.path,
  );
}

function readAllow(options: unknown): AllowEntry[] {
  // The schema has already rejected anything malformed by the time this runs.
  if (!isRecord(options) || !Array.isArray(options['allow'])) return [];
  const entries: unknown[] = options['allow'];
  return entries.filter(
    (entry): entry is AllowEntry =>
      isRecord(entry) && typeof entry['path'] === 'string' && typeof entry['reason'] === 'string',
  );
}

function isShadowed(scope: Scope.Scope | null, name: string): boolean {
  for (let current = scope; current !== null; current = current.upper) {
    const variable = current.set.get(name);
    if (variable !== undefined) return variable.defs.length > 0;
  }
  return false;
}

// typeof fetch in a type position is recorded as a value reference by the TypeScript
// scope manager, but it describes a type and loads nothing.
function isRuntimeReference(reference: Scope.Reference): boolean {
  const parent: unknown = (reference.identifier as { parent?: unknown }).parent;
  if (isRecord(parent) && parent['type'] === 'TSTypeQuery') return false;
  return (reference as { isValueReference?: boolean }).isValueReference !== false;
}

export const noRawEgress: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Send outbound network calls through @drefyn/egress' },
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          allow: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['path', 'reason'],
              properties: {
                // Relative to the workspace root. A trailing slash allows a directory.
                path: { type: 'string', pattern: '^(?![/\\\\])(?!.*(^|/)\\.\\.(/|$)).+$' },
                // Every entry is a security exception, so it has to say why.
                reason: { type: 'string', pattern: '\\S' },
              },
            },
          },
        },
      },
    ],
    messages: {
      raw: "Outbound network calls go through @drefyn/egress (guardedFetch). Raw '{{api}}' is not allowed in {{pkg}}.",
    },
  },
  create(context) {
    const file = context.filename;
    const root = isAbsolute(file) ? findWorkspaceRoot(dirname(file)) : undefined;
    let pkg = 'this file';
    if (root !== undefined) {
      const workspace = cachedWorkspace(root);
      const rel = relative(root, file).split(sep).join('/');
      if (isAllowed(rel, readAllow(context.options[0]))) return {};
      const owner = ownerOf(workspace, file);
      const rootName = workspace.rootManifest['name'];
      pkg =
        owner?.name ?? owner?.rel ?? (typeof rootName === 'string' ? rootName : 'the root package');
    }
    const report = (loc: AST.SourceLocation | null | undefined, api: string) => {
      if (loc) context.report({ loc, messageId: 'raw', data: { api, pkg } });
    };

    return {
      ...moduleReferences(({ spec, loc, typeOnly }) => {
        if (!typeOnly && isBannedModule(spec)) report(loc, spec);
      }),
      // globalThis.fetch, window['fetch'] and friends, unless the object is a local.
      MemberExpression: (node) => {
        if (node.object.type !== 'Identifier' || !GLOBAL_OBJECTS.has(node.object.name)) return;
        const property = node.property;
        let name: unknown;
        if (!node.computed && property.type === 'Identifier') name = property.name;
        else if (node.computed && property.type === 'Literal') name = property.value;
        if (typeof name !== 'string' || !GLOBAL_APIS.has(name)) return;
        if (isShadowed(context.sourceCode.getScope(node), node.object.name)) return;
        report(node.loc, name);
      },
      // Bare fetch and WebSocket, called or passed around. Unresolved names sit in
      // through; configured and lib globals are variables with no definition.
      'Program:exit': (node) => {
        const scope = context.sourceCode.getScope(node);
        const references = new Set(scope.through);
        for (const variable of scope.variables) {
          if (variable.defs.length === 0)
            for (const ref of variable.references) references.add(ref);
        }
        for (const reference of references) {
          const { name } = reference.identifier;
          if (GLOBAL_APIS.has(name) && isRuntimeReference(reference))
            report(reference.identifier.loc, name);
        }
      },
    };
  },
};

import { relative, sep } from 'node:path';
import type { AST, Rule, Scope } from 'eslint';
import { literal, moduleReferences } from './references.ts';
import {
  cachedWorkspace,
  isRecord,
  ownerOf,
  workspaceRootFor,
  type WorkspacePackage,
} from './workspace.ts';

// Each of these can open a socket or resolve a name without the guard. http2 is listed
// because it reaches the same hosts as http and https. The underscored ones are the
// internals behind http and tls, which Node still lets anyone import.
const BANNED_BUILTINS = new Set([
  'http',
  'https',
  'http2',
  'net',
  'tls',
  'dgram',
  'dns',
  'dns/promises',
  '_http_agent',
  '_http_client',
  '_http_common',
  '_http_incoming',
  '_http_outgoing',
  '_http_server',
  '_tls_common',
  '_tls_wrap',
  '_stream_wrap',
  // Experimental in Node 24 behind a flag, but it opens UDP based connections.
  'quic',
]);
const GLOBAL_APIS = new Set(['fetch', 'WebSocket']);
const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self', 'global']);
// Type only wrappers that leave the value as it is at run time.
const TS_WRAPPERS = new Set([
  'TSAsExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
  'TSSatisfiesExpression',
]);
// What Node runs or parses when require loads a relative file by this extension; any
// other extension is run as JavaScript too, which no linter here reads.
const REQUIRE_SAFE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
]);

interface AllowEntry {
  path: string;
  reason: string;
}

function isBannedModule(spec: string): boolean {
  if (spec.startsWith('node:')) return BANNED_BUILTINS.has(spec.slice('node:'.length));
  return BANNED_BUILTINS.has(spec) || spec === 'undici' || spec.startsWith('undici/');
}

// The exemption follows the package, not the path text, so a folder that only looks
// like packages/egress (no manifest, another name, a stray workspace file) gets none.
function isEgressPackage(owner: WorkspacePackage | undefined): boolean {
  return owner?.name === '@drefyn/egress' && owner.rel === 'packages/egress';
}

function isAllowed(rel: string, allow: readonly AllowEntry[]): boolean {
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

// declare emits no code, so a name declared only that way is still the global at run
// time. A real binding anywhere in the chain is a local.
function isAmbient(def: Scope.Definition): boolean {
  for (let node: unknown = def.node; isRecord(node); node = node['parent']) {
    if (node['declare'] === true || node['type'] === 'TSDeclareFunction') return true;
    if (node['type'] === 'Program') return false;
  }
  return false;
}

const isRealBinding = (variable: Scope.Variable) =>
  variable.defs.length > 0 && !variable.defs.every(isAmbient);

function isShadowed(scope: Scope.Scope | null, name: string): boolean {
  for (let current = scope; current !== null; current = current.upper) {
    const variable = current.set.get(name);
    if (variable !== undefined && isRealBinding(variable)) return true;
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

type Node = Rule.Node;

// A static property name: a.b, a['b'] and { b: x } or { ['b']: x } in a pattern.
function staticName(key: unknown, computed: boolean): string | undefined {
  if (!isRecord(key)) return undefined;
  if (!computed && key['type'] === 'Identifier' && typeof key['name'] === 'string') {
    return key['name'];
  }
  if (key['type'] === 'Literal' && typeof key['value'] === 'string') return key['value'];
  return undefined;
}

function unwrap(node: unknown): unknown {
  let current = node;
  while (
    isRecord(current) &&
    typeof current['type'] === 'string' &&
    TS_WRAPPERS.has(current['type'])
  ) {
    current = current['expression'];
  }
  return current;
}

// A string or a template with no ${}, the same forms imports accept.
function stringArgument(node: { arguments: unknown[] }): string | undefined {
  return literal(node.arguments[0])?.spec;
}

// A relative require of a file Node will run as code although nothing lints it.
function isOpaqueLoad(spec: string): boolean {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return false;
  const name = spec.split('/').at(-1) ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 && !REQUIRE_SAFE_EXTENSIONS.has(name.slice(dot));
}

// createRequire(...) under any local name, or <x>.createRequire(...); both return a
// working require.
function isCreateRequireCall(node: unknown, names: ReadonlySet<string>): boolean {
  if (!isRecord(node) || node['type'] !== 'CallExpression') return false;
  const callee = unwrap(node['callee']);
  if (!isRecord(callee)) return false;
  if (callee['type'] === 'Identifier') {
    return typeof callee['name'] === 'string' && names.has(callee['name']);
  }
  return (
    callee['type'] === 'MemberExpression' &&
    staticName(callee['property'], callee['computed'] === true) === 'createRequire'
  );
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
      opaque:
        "'{{spec}}' loads a file that is not source as code, so the egress rule cannot check it. Rename it to a source extension.",
    },
  },
  create(context) {
    const file = context.filename;
    const root = workspaceRootFor(file, context.settings);
    let pkg = 'this file';
    if (root !== undefined) {
      const workspace = cachedWorkspace(root);
      const rel = relative(root, file).split(sep).join('/');
      const owner = ownerOf(workspace, file);
      if (isEgressPackage(owner) || isAllowed(rel, readAllow(context.options[0]))) return {};
      const rootName = workspace.rootManifest['name'];
      pkg =
        owner?.name ?? owner?.rel ?? (typeof rootName === 'string' ? rootName : 'the root package');
    }
    const report = (loc: AST.SourceLocation | null | undefined, api: string) => {
      if (loc) context.report({ loc, messageId: 'raw', data: { api, pkg } });
    };
    // Every require style call: require, <x>.require, and a require from createRequire.
    const reportModule = (
      node: { arguments: unknown[]; loc?: AST.SourceLocation | null | undefined },
      banned = true,
    ) => {
      const spec = stringArgument(node);
      if (spec === undefined || !node.loc) return;
      if (banned && isBannedModule(spec)) report(node.loc, spec);
      if (isOpaqueLoad(spec))
        context.report({ loc: node.loc, messageId: 'opaque', data: { spec } });
    };
    // Local names bound to createRequire by an import from module or node:module.
    const createRequireNames = new Set(['createRequire']);

    // globalThis, or globalThis.globalThis and the like, unless a local has the name.
    const isGlobalObject = (raw: unknown, at: Node): boolean => {
      const node = unwrap(raw);
      if (!isRecord(node)) return false;
      if (node['type'] === 'Identifier' && typeof node['name'] === 'string') {
        return (
          GLOBAL_OBJECTS.has(node['name']) &&
          !isShadowed(context.sourceCode.getScope(at), node['name'])
        );
      }
      if (node['type'] !== 'MemberExpression') return false;
      const name = staticName(node['property'], node['computed'] === true);
      return name !== undefined && GLOBAL_OBJECTS.has(name) && isGlobalObject(node['object'], at);
    };

    // const { fetch } = globalThis, nested patterns included.
    const checkPattern = (pattern: unknown, at: Node) => {
      if (!isRecord(pattern) || pattern['type'] !== 'ObjectPattern') return;
      const properties: unknown = pattern['properties'];
      if (!Array.isArray(properties)) return;
      for (const property of properties as unknown[]) {
        if (!isRecord(property) || property['type'] !== 'Property') continue;
        const name = staticName(property['key'], property['computed'] === true);
        if (name !== undefined && GLOBAL_APIS.has(name)) {
          report((property['key'] as { loc?: AST.SourceLocation }).loc, name);
        } else if (name !== undefined && GLOBAL_OBJECTS.has(name)) {
          const value = property['value'];
          checkPattern(
            isRecord(value) && value['type'] === 'AssignmentPattern' ? value['left'] : value,
            at,
          );
        }
      }
    };
    const destructure = (pattern: unknown, source: unknown, at: Node) => {
      if (isGlobalObject(source, at)) checkPattern(pattern, at);
    };

    const modules = moduleReferences(({ spec, loc, typeOnly }) => {
      if (!typeOnly && isBannedModule(spec)) report(loc, spec);
    });
    return {
      ...modules,
      // globalThis.fetch, window['fetch'] and friends, unless the object is a local.
      MemberExpression: (node) => {
        const name = staticName(node.property, node.computed);
        if (name === undefined || !GLOBAL_APIS.has(name)) return;
        if (isGlobalObject(node.object, node)) report(node.loc, name);
      },
      VariableDeclarator: (node) => {
        destructure(node.id, node.init, node);
        // const load = createRequire(...); load('node:http')
        if (node.id.type !== 'Identifier' || !isCreateRequireCall(node.init, createRequireNames)) {
          return;
        }
        for (const variable of context.sourceCode.getDeclaredVariables(node)) {
          for (const reference of variable.references) {
            const parent = (reference.identifier as Partial<Node>).parent;
            if (parent?.type === 'CallExpression' && parent.callee === reference.identifier) {
              reportModule(parent);
            }
          }
        }
      },
      AssignmentExpression: (node) => {
        destructure(node.left, node.right, node);
      },
      AssignmentPattern: (node) => {
        destructure(node.left, node.right, node);
      },
      Program: (node) => {
        for (const statement of node.body) {
          if (statement.type !== 'ImportDeclaration') continue;
          const from = statement.source.value;
          if (from !== 'module' && from !== 'node:module') continue;
          for (const specifier of statement.specifiers) {
            if (
              specifier.type === 'ImportSpecifier' &&
              staticName(specifier.imported, false) === 'createRequire'
            ) {
              createRequireNames.add(specifier.local.name);
            }
          }
        }
      },
      CallExpression: (node) => {
        modules.CallExpression?.(node);
        const callee = node.callee;
        // require('x') itself: moduleReferences already reported a banned name.
        if (callee.type === 'Identifier' && callee.name === 'require') {
          reportModule(node, false);
          return;
        }
        // createRequire(import.meta.url)('node:http')
        if (isCreateRequireCall(callee, createRequireNames)) {
          reportModule(node);
          return;
        }
        if (callee.type !== 'MemberExpression') return;
        // process.getBuiltinModule('node:http') and module.require('http'). Any object
        // will do: the banned names mean nothing else, so a match is never innocent.
        const method = staticName(callee.property, callee.computed);
        if (method === 'getBuiltinModule' || method === 'require') reportModule(node);
      },
      // Bare fetch and WebSocket, called or passed around. Unresolved names sit in
      // scope.through; configured and lib globals are variables with no definition,
      // and a declare only binding is still the global.
      'Program:exit': (node) => {
        const scope = context.sourceCode.getScope(node);
        const references = new Set(scope.through);
        for (const each of context.sourceCode.scopeManager.scopes) {
          for (const variable of each.variables) {
            if (!GLOBAL_APIS.has(variable.name) || isRealBinding(variable)) continue;
            for (const ref of variable.references) references.add(ref);
          }
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

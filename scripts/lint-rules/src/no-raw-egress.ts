import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, relative, sep } from 'node:path';
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

// A namespace that holds only types (aliases, interfaces, nested such namespaces, or
// exports of them) emits no code. One with values is a real run time object.
function isTypesOnlyNamespace(node: unknown): boolean {
  if (!isRecord(node) || node['type'] !== 'TSModuleDeclaration') return false;
  const body = node['body'];
  if (body === undefined || body === null) return true;
  if (isRecord(body) && body['type'] === 'TSModuleDeclaration') return isTypesOnlyNamespace(body);
  if (!isRecord(body) || !Array.isArray(body['body'])) return false;
  const statements: unknown[] = body['body'];
  return statements.every((statement) => {
    const inner =
      isRecord(statement) && statement['type'] === 'ExportNamedDeclaration'
        ? statement['declaration']
        : statement;
    if (!isRecord(inner)) return false;
    if (inner['type'] === 'TSTypeAliasDeclaration' || inner['type'] === 'TSInterfaceDeclaration') {
      return true;
    }
    return isTypesOnlyNamespace(inner);
  });
}

// TypeScript also erases a type alias, an interface, a types only namespace and a type
// only import, so none of them shadows the global either. A pure alias or interface is
// already a type only variable; the alias and interface branch below is for a name
// merged with an ambient declare, where every definition is erased but the variable
// still counts as a value.
function isErased(def: Scope.Definition): boolean {
  if (isAmbient(def)) return true;
  const node: unknown = def.node;
  // ESLint's types list only JavaScript definition kinds; typescript-eslint adds these.
  if ((def.type as string) === 'TSModuleName') return isTypesOnlyNamespace(node);
  if (!isRecord(node)) return false;
  if (node['type'] === 'TSTypeAliasDeclaration' || node['type'] === 'TSInterfaceDeclaration') {
    return true;
  }
  if (def.type !== 'ImportBinding') return false;
  const declaration = node['parent'];
  return (
    node['importKind'] === 'type' || (isRecord(declaration) && declaration['importKind'] === 'type')
  );
}

const isRealBinding = (variable: Scope.Variable) =>
  (variable as { isValueVariable?: boolean }).isValueVariable !== false &&
  variable.defs.length > 0 &&
  !variable.defs.every(isErased);

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

// Where Node's require would load a relative specifier from this file, or undefined
// when it does not resolve (Node throws at run time) or is not relative. Judging the
// resolved file, not the text, handles ./net (no extension), ./.tls, ./lib.v2 that
// resolves to lib.v2.js and a directory that resolves to its index.
// Node caches resolutions for the life of the process, so a long running editor ESLint
// can keep an old answer after a rename; the gate starts fresh every run.
function resolveRelative(file: string, spec: string): string | undefined {
  if (!isAbsolute(file)) return undefined;
  if (spec !== '.' && spec !== '..' && !spec.startsWith('./') && !spec.startsWith('../')) {
    return undefined;
  }
  try {
    return createRequire(file).resolve(spec);
  } catch {
    return undefined;
  }
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
        "'{{spec}}' resolves to {{file}}, which is not source; Node would run it as code. Use a source extension or .json.",
      addon: "'{{spec}}' resolves to {{file}}, which is not source; Node would run it as code.",
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
    // Resolution returns real paths, so compare against the real root (macOS keeps
    // temp folders behind /var -> /private/var).
    let realRoot: string | undefined;
    const shown = (target: string) => {
      if (root !== undefined) realRoot ??= realpathSync(root);
      return relative(realRoot ?? dirname(file), target)
        .split(sep)
        .join('/');
    };
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
      const target = resolveRelative(file, spec);
      if (target === undefined) return;
      const ext = extname(target);
      if (REQUIRE_SAFE_EXTENSIONS.has(ext)) return;
      context.report({
        loc: node.loc,
        messageId: ext === '.node' ? 'addon' : 'opaque',
        data: { spec, file: shown(target) },
      });
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

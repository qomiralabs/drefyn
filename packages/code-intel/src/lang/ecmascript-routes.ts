import type { Node } from 'web-tree-sitter';
import type { Collector } from '../collector.ts';
import { literalText } from '../text.ts';

const FRAMEWORKS: Readonly<Record<string, string>> = {
  express: 'express',
  fastify: 'fastify',
  hono: 'hono',
  'koa-router': 'koa',
  '@koa/router': 'koa',
};

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']);
const NEXT_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
// Names apps and routers go by when they arrive as parameters from another file.
const CONVENTIONAL = ['app', 'router', 'server', 'api', 'fastify'];

const argumentsOf = (call: Node): Node[] =>
  (call.childForFieldName('arguments')?.namedChildren ?? []).filter(
    (child) => child.type !== 'comment',
  );

// The identifier a callee starts from: `express` in `express.Router()`, `require` in
// `require('fastify')()`.
function rootIdentifier(node: Node | null): Node | null {
  let current = node;
  while (current !== null && current.type !== 'identifier') {
    current =
      current.childForFieldName('object') ??
      current.childForFieldName('function') ??
      current.childForFieldName('constructor');
  }
  return current;
}

function requiredModule(call: Node): string | undefined {
  const callee = call.childForFieldName('function');
  if (callee?.type !== 'identifier' || callee.text !== 'require') return undefined;
  return literalText(argumentsOf(call)[0]);
}

// Local names bound to a framework module, by import or require.
function frameworkImports(root: Node): Map<string, string> {
  const locals = new Map<string, string>();
  for (const node of root.namedChildren) {
    if (node.type !== 'import_statement') continue;
    const framework = FRAMEWORKS[literalText(node.childForFieldName('source')) ?? ''];
    if (framework === undefined) continue;
    for (const name of node.descendantsOfType(['identifier'])) {
      if (name.parent?.type !== 'string') locals.set(name.text, framework);
    }
  }
  for (const call of root.descendantsOfType('call_expression')) {
    const framework = FRAMEWORKS[requiredModule(call) ?? ''];
    if (framework === undefined) continue;
    const declarator = call.parent?.type === 'variable_declarator' ? call.parent : null;
    const name = declarator?.childForFieldName('name');
    // `require('fastify')()` binds no name to the module, but the file still uses it, and the
    // key only has to count it.
    locals.set(name?.type === 'identifier' ? name.text : `require:${framework}`, framework);
  }
  return locals;
}

// Variables made from a framework: `const app = express()`, `const r = new Router()`.
function appBindings(root: Node, locals: ReadonlyMap<string, string>): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const declarator of root.descendantsOfType('variable_declarator')) {
    const name = declarator.childForFieldName('name');
    const value = declarator.childForFieldName('value');
    if (name?.type !== 'identifier' || value === null) continue;
    if (value.type !== 'call_expression' && value.type !== 'new_expression') continue;
    const start = rootIdentifier(value);
    if (start === null) continue;
    const inner = start.parent?.type === 'call_expression' ? start.parent : null;
    const required = inner === null ? undefined : FRAMEWORKS[requiredModule(inner) ?? ''];
    const framework = required ?? locals.get(start.text);
    if (framework !== undefined) bindings.set(name.text, framework);
  }
  return bindings;
}

function fastifyRoute(options: Node | undefined, framework: string, out: Collector): boolean {
  if (options?.type !== 'object') return false;
  const pairs = new Map<string, Node>();
  for (const pair of options.namedChildren) {
    const key = pair.childForFieldName('key');
    const value = pair.childForFieldName('value');
    if (pair.type === 'pair' && key !== null && value !== null) pairs.set(key.text, value);
  }
  const url = literalText(pairs.get('url') ?? pairs.get('path'));
  const method = pairs.get('method');
  const methods =
    method?.type === 'array' ? method.namedChildren.map(literalText) : [literalText(method)];
  if (url === undefined || methods.length === 0 || methods.includes(undefined)) return false;
  for (const name of methods) if (name !== undefined) out.route(name, url, framework);
  return true;
}

const ROUTE_FILES = new Set(['route.ts', 'route.tsx', 'route.js', 'route.jsx', 'route.mjs']);

// The folders between the first `app` folder and route.ts, when every one of them is named.
// A single pass over the path's segments: the path comes from the customer's repository, and a
// pattern that retries from each `app/` costs quadratic time on a crafted one.
function nextRouteFolders(path: string): string[] | undefined {
  const parts = path.split('/');
  const last = parts.length - 1;
  if (!ROUTE_FILES.has(parts[last] ?? '')) return undefined;
  let app = -1;
  for (let index = 0; index < last; index += 1) {
    const part = parts[index];
    if (part === '') app = -1;
    else if (part === 'app' && app === -1) app = index;
  }
  return app === -1 ? undefined : parts.slice(app + 1, last);
}

const isGroup = (segment: string): boolean => segment.startsWith('(') && segment.endsWith(')');

// Next's app router: an exported GET in app/**/route.ts answers at the folder's path.
function nextRoutes(out: Collector): void {
  const folders = nextRouteFolders(out.path);
  if (folders === undefined) return;
  const segments = folders.filter((segment) => !isGroup(segment) && !segment.startsWith('@'));
  const route = `/${segments.join('/')}`;
  for (const symbol of [...out.symbols]) {
    if (symbol.exported && symbol.kind === 'function' && NEXT_METHODS.has(symbol.name)) {
      out.route(symbol.name, route, 'next');
    }
  }
}

export function ecmascriptRoutes(root: Node, out: Collector): void {
  nextRoutes(out);
  const locals = frameworkImports(root);
  if (locals.size === 0) return;
  const bindings = appBindings(root, locals);
  const fallback = [...locals.values()][0] ?? 'express';
  for (const name of CONVENTIONAL) if (!bindings.has(name)) bindings.set(name, fallback);

  for (const call of root.descendantsOfType('call_expression')) {
    const callee = call.childForFieldName('function');
    if (callee?.type !== 'member_expression') continue;
    const object = callee.childForFieldName('object');
    const property = callee.childForFieldName('property')?.text ?? '';
    const framework = object?.type === 'identifier' ? bindings.get(object.text) : undefined;
    if (framework === undefined) continue;
    const [first] = argumentsOf(call);
    if (property === 'route') {
      if (!fastifyRoute(first, framework, out)) out.partial = true;
      continue;
    }
    if (property === 'use') {
      // A mount moves every route of the router under its prefix, which is not followed.
      if (first !== undefined && literalText(first) !== undefined) out.partial = true;
      continue;
    }
    if (!METHODS.has(property) || first === undefined) continue;
    const route = literalText(first);
    if (route === undefined) out.partial = true;
    else if (route.startsWith('/') || route === '*') {
      out.route(property === 'all' ? 'ANY' : property, route, framework);
    }
  }
}

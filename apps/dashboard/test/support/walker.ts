import { readdirSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export type WalkerProblem =
  | 'guard_missing'
  | 'public_guard'
  | 'action_unwrapped'
  | 'route_unwrapped'
  | 'inline_use_server'
  | 'pages_router'
  | 'javascript_source';

export interface Finding {
  readonly path: string;
  readonly line: number;
  readonly name: string;
  readonly problem: WalkerProblem;
}

type Guard =
  'guardOrganization' | 'guardSignedIn' | 'guardPublic' | 'guardSession' | 'guardAccountHome';

const ROUTE_FILE = /^src\/app\/(?:.*\/)?route\.tsx?$/;
// Metadata files are GET routes under another name.
const RENDER_FILE =
  /^src\/app\/(?:.*\/)?(?:page|layout|template|default|opengraph-image\d*|twitter-image\d*|icon\d*|apple-icon\d*|sitemap|robots|manifest)\.tsx?$/;
const RENDER_EXPORTS = new Set([
  'generateMetadata',
  'generateViewport',
  'generateImageMetadata',
  'generateSitemaps',
]);
const JAVASCRIPT = /\.[cm]?jsx?$/;
const SOURCE = /\.[cm]?[jt]sx?$/;
const GET_LIKE = new Set(['GET', 'HEAD', 'OPTIONS']);
const ACTION_WRAPPERS = new Set(['publicAction', 'signedInAction', 'orgAction']);
const ROUTE_WRAPPERS = new Set(['publicRoute', 'signedInRoute', 'orgRoute']);
const OWN_MODULES: ReadonlySet<string> = new Set(['src/server/guard', 'src/server/actions']);

// The root layout wraps the 404 page too, so it can never hold a guard, and it reads nothing.
const UNGUARDED: ReadonlySet<string> = new Set(['src/app/layout.tsx']);
// Pages that hold no data. Each new one is a reviewed line here.
const PUBLIC_PAGES: ReadonlySet<string> = new Set([
  'src/app/auth-states/[screen]/[state]/page.tsx',
  'src/app/bundle-baseline/page.tsx',
  'src/app/invite/block/page.tsx',
  'src/app/invite/page.tsx',
  'src/app/sign-in/cli/page.tsx',
  'src/app/sign-in/link/page.tsx',
  'src/app/sign-in/page.tsx',
  'src/app/sign-in/password/page.tsx',
  'src/app/sign-in/reset/page.tsx',
  'src/app/sign-in/verify/page.tsx',
  'src/app/settings-states/[screen]/[state]/page.tsx',
  'src/app/sign-up/page.tsx',
]);
// A person's own pages, which no organization in the URL can guard.
const ACCOUNT_PATH = 'src/app/account/';
const NO_ORGANIZATION_PAGE = 'src/app/organizations/new/page.tsx';
// Signed out GET handlers, such as an OAuth callback. Each new one is a reviewed line too.
const PUBLIC_GET_ROUTES: ReadonlySet<string> = new Set<string>([
  'src/app/auth/oauth/[provider]/callback/route.ts',
  'src/app/auth/oauth/[provider]/start/route.ts',
  'src/app/auth/pre/route.ts',
  'src/app/settings-states/whoami/route.ts',
]);

// Groups and slots change no URL, so a path is judged as if they were not there.
const routePath = (path: string) => path.replace(/\/(?:\([^/]*\)|@[^/]*)(?=\/)/g, '');

// Allow lists match the path as written, so a group cannot borrow an entry.
function acceptedGuards(path: string): readonly Guard[] {
  if (PUBLIC_PAGES.has(path) || PUBLIC_GET_ROUTES.has(path)) return ['guardPublic'];
  if (path.startsWith(ACCOUNT_PATH)) return ['guardAccountHome'];
  if (path === NO_ORGANIZATION_PAGE) return ['guardSession'];
  return routePath(path) === 'src/app/page.tsx' ? ['guardSignedIn'] : ['guardOrganization'];
}

type FunctionNode =
  ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

interface FileFacts {
  readonly source: ts.SourceFile;
  // Local name to the name exported by a guard or wrapper module.
  readonly imported: ReadonlyMap<string, string>;
  readonly functions: ReadonlyMap<string, FunctionNode>;
  readonly constants: ReadonlyMap<string, ts.Expression>;
}

const directivesOf = (statements: readonly ts.Statement[]): readonly string[] => {
  const found: string[] = [];
  for (const statement of statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    found.push(statement.expression.text);
  }
  return found;
};

const isFunctionNode = (node: ts.Node | undefined): node is FunctionNode =>
  node !== undefined &&
  (ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node));

function factsOf(path: string, text: string): FileFacts {
  const kind = path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const imported = new Map<string, string>();
  const functions = new Map<string, FunctionNode>();
  const constants = new Map<string, ts.Expression>();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const from = statement.moduleSpecifier.text;
      const bindings = statement.importClause?.namedBindings;
      if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
      // Resolved from this file, so ../evil/server/guard.ts is not the guard.
      const resolved = posix.normalize(posix.join(posix.dirname(path), from)).replace(/\.ts$/, '');
      if (!OWN_MODULES.has(resolved)) continue;
      for (const element of bindings.elements) {
        imported.set(element.name.text, (element.propertyName ?? element.name).text);
      }
    }
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      functions.set(statement.name.text, statement);
    }
    if (ts.isVariableStatement(statement)) {
      if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
        constants.set(declaration.name.text, declaration.initializer);
        if (isFunctionNode(declaration.initializer)) {
          functions.set(declaration.name.text, declaration.initializer);
        }
      }
    }
  }
  return { source, imported, functions, constants };
}

interface ExportEntry {
  readonly name: string;
  readonly node: ts.Node;
  // The exported expression or declaration; undefined when it lives in another file, which
  // nothing here can read, so it can never pass.
  readonly value: ts.Node | undefined;
}

const hasExport = (node: ts.HasModifiers): boolean =>
  ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
const hasDefault = (node: ts.HasModifiers): boolean =>
  ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) === true;

function exportsOf(facts: FileFacts): readonly ExportEntry[] {
  const entries: ExportEntry[] = [];
  const local = (name: string): ts.Node | undefined =>
    facts.constants.get(name) ?? facts.functions.get(name);
  for (const statement of facts.source.statements) {
    if (ts.isFunctionDeclaration(statement) && hasExport(statement)) {
      const name = hasDefault(statement) ? 'default' : (statement.name?.text ?? 'default');
      entries.push({ name, node: statement, value: statement });
    } else if (ts.isVariableStatement(statement) && hasExport(statement)) {
      const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
      for (const declaration of statement.declarationList.declarations) {
        // Names out of a pattern come from a value nothing here can read, so they never pass.
        if (!ts.isIdentifier(declaration.name)) {
          for (const element of declaration.name.elements) {
            if (!ts.isBindingElement(element)) continue;
            const name = ts.isIdentifier(element.name) ? element.name.text : '(pattern)';
            entries.push({ name, node: declaration, value: undefined });
          }
          continue;
        }
        entries.push({
          name: declaration.name.text,
          node: declaration,
          value: isConst ? declaration.initializer : undefined,
        });
      }
    } else if (ts.isExportAssignment(statement)) {
      const { expression } = statement;
      const value = ts.isIdentifier(expression) ? local(expression.text) : expression;
      entries.push({ name: 'default', node: statement, value });
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      const { exportClause, moduleSpecifier } = statement;
      if (exportClause === undefined) {
        entries.push({ name: '*', node: statement, value: undefined });
      } else if (ts.isNamedExports(exportClause)) {
        for (const element of exportClause.elements) {
          if (element.isTypeOnly) continue;
          const original = (element.propertyName ?? element.name).text;
          entries.push({
            name: element.name.text,
            node: statement,
            value: moduleSpecifier === undefined ? local(original) : undefined,
          });
        }
      }
    }
  }
  return entries;
}

// The wrapper a value is a direct call of, resolved through the import, or undefined. An
// alias, a member call or a wrapper inside another call is unknown, and unknown fails.
function wrapperOf(facts: FileFacts, value: ts.Node | undefined): string | undefined {
  if (value === undefined || !ts.isCallExpression(value)) return undefined;
  return ts.isIdentifier(value.expression) ? facts.imported.get(value.expression.text) : undefined;
}

function firstCall(node: ts.Node): ts.CallExpression | undefined {
  if (ts.isCallExpression(node)) return node;
  return ts.forEachChild(node, firstCall);
}

function containsCall(node: ts.Node): boolean {
  return firstCall(node) !== undefined;
}

const isParamsAwait = (statement: ts.Statement): boolean => {
  if (!ts.isVariableStatement(statement)) return false;
  return statement.declarationList.declarations.every(
    (d) =>
      d.initializer !== undefined &&
      ts.isAwaitExpression(d.initializer) &&
      ts.isIdentifier(d.initializer.expression) &&
      d.initializer.expression.text === 'params',
  );
};

function declaresName(body: ts.Node, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isParameter(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

function bare(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) ? bare(node.expression) : node;
}

// `await f(...)`, alone or as the root of a property read. Anything around it, such as &&, ?:
// or a comma, can stop it running, so it is not accepted.
function awaitedCall(expression: ts.Expression): ts.CallExpression | undefined {
  let node = bare(expression);
  while (ts.isPropertyAccessExpression(node)) node = bare(node.expression);
  if (!ts.isAwaitExpression(node)) return undefined;
  const inner = bare(node.expression);
  return ts.isCallExpression(inner) ? inner : undefined;
}

function leadingCall(statement: ts.Statement): ts.CallExpression | undefined {
  if (ts.isExpressionStatement(statement)) return awaitedCall(statement.expression);
  if (ts.isVariableStatement(statement)) {
    const [only, extra] = statement.declarationList.declarations;
    if (only?.initializer === undefined || extra !== undefined) return undefined;
    return awaitedCall(only.initializer);
  }
  if (!ts.isReturnStatement(statement) || statement.expression === undefined) return undefined;
  const value = bare(statement.expression);
  if (!ts.isObjectLiteralExpression(value)) return awaitedCall(value);
  // Properties run in order, so only the first can be first.
  const first = value.properties[0];
  return first !== undefined && ts.isPropertyAssignment(first)
    ? awaitedCall(first.initializer)
    : undefined;
}

// The local names `const { org } = await params` gives the route's org param.
function orgNames(statements: readonly ts.Statement[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const { name } of statement.declarationList.declarations) {
      if (!ts.isObjectBindingPattern(name)) continue;
      for (const element of name.elements) {
        const key = element.propertyName ?? element.name;
        if (ts.isIdentifier(key) && key.text === 'org' && ts.isIdentifier(element.name)) {
          names.add(element.name.text);
        }
      }
    }
  }
  return names;
}

// Only the slug in the URL may pick the organization, so a fixed one cannot stand in.
function isRouteOrg(args: readonly ts.Expression[], names: ReadonlySet<string>): boolean {
  const [only, extra] = args;
  if (only === undefined || extra !== undefined) return false;
  if (ts.isIdentifier(only)) return names.has(only.text);
  if (!ts.isPropertyAccessExpression(only) || only.name.text !== 'org') return false;
  const target = bare(only.expression);
  return (
    ts.isAwaitExpression(target) &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === 'params'
  );
}

// The guard a function runs before anything else, followed through helpers in this file.
// Only destructuring `await params` may come first, then one statement that is the await.
function guardOf(
  facts: FileFacts,
  fn: FunctionNode | undefined,
  seen: ReadonlySet<FunctionNode> = new Set(),
): string | undefined {
  if (fn?.body === undefined || !ts.isBlock(fn.body) || seen.has(fn)) return undefined;
  const index = fn.body.statements.findIndex((s) => !isParamsAwait(s));
  const statement = fn.body.statements[index];
  if (statement === undefined) return undefined;
  const call = leadingCall(statement);
  if (call === undefined || !ts.isIdentifier(call.expression)) return undefined;
  if (call.arguments.some(containsCall)) return undefined;
  const name = call.expression.text;
  if (declaresName(fn, name)) return undefined;
  const guard = facts.imported.get(name);
  if (guard === 'guardOrganization') {
    const names = orgNames(fn.body.statements.slice(0, index));
    return isRouteOrg(call.arguments, names) ? guard : undefined;
  }
  if (guard !== undefined) return guard;
  return guardOf(facts, facts.functions.get(name), new Set([...seen, fn]));
}

function inlineDirectives(facts: FileFacts, path: string): readonly Finding[] {
  const findings: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isBlock(node) && isFunctionNode(node.parent)) {
      if (directivesOf(node.statements).includes('use server')) {
        findings.push(findingAt(facts, path, node, '(inline)', 'inline_use_server'));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(facts.source);
  return findings;
}

function findingAt(
  facts: FileFacts,
  path: string,
  node: ts.Node,
  name: string,
  problem: WalkerProblem,
): Finding {
  const start = node.getStart(facts.source);
  const line = facts.source.getLineAndCharacterOfPosition(start).line + 1;
  return { path, line, name, problem };
}

function guardProblem(path: string, guard: string | undefined): WalkerProblem {
  const refusedHere = path.startsWith('src/app/[org]/') || routePath(path) === 'src/app/page.tsx';
  return guard === 'guardPublic' && !refusedHere ? 'public_guard' : 'guard_missing';
}

function renderFindings(facts: FileFacts, path: string): readonly Finding[] {
  if (!RENDER_FILE.test(path) || UNGUARDED.has(path)) return [];
  const accepted = acceptedGuards(path);
  const findings: Finding[] = [];
  for (const entry of exportsOf(facts)) {
    const render = entry.name === 'default' || entry.name === '*';
    if (!render && !RENDER_EXPORTS.has(entry.name)) continue;
    const guard = isFunctionNode(entry.value) ? guardOf(facts, entry.value) : undefined;
    if (accepted.some((name) => name === guard)) continue;
    findings.push(findingAt(facts, path, entry.node, entry.name, guardProblem(path, guard)));
  }
  return findings;
}

function actionFindings(facts: FileFacts, path: string): readonly Finding[] {
  if (!directivesOf(facts.source.statements).includes('use server')) return [];
  return exportsOf(facts)
    .filter((entry) => !ACTION_WRAPPERS.has(wrapperOf(facts, entry.value) ?? ''))
    .map((entry) => findingAt(facts, path, entry.node, entry.name, 'action_unwrapped'));
}

// A non GET handler needs a wrapper for its Origin check. A GET has no Origin on a plain
// navigation, so it may start with the guard instead.
function routeFindings(facts: FileFacts, path: string): readonly Finding[] {
  if (!ROUTE_FILE.test(path)) return [];
  const accepted = acceptedGuards(path);
  const passes = (entry: ExportEntry): boolean => {
    if (ROUTE_WRAPPERS.has(wrapperOf(facts, entry.value) ?? '')) return true;
    if (!GET_LIKE.has(entry.name) || !isFunctionNode(entry.value)) return false;
    const guard = guardOf(facts, entry.value);
    return accepted.some((name) => name === guard);
  };
  return exportsOf(facts)
    .filter((entry) => !passes(entry))
    .map((entry) => findingAt(facts, path, entry.node, entry.name, 'route_unwrapped'));
}

// Reads one file. An inline directive is refused alone, because it makes an action no export
// shows and the rest of the file proves nothing about it.
export function checkSource(path: string, text: string): readonly Finding[] {
  // Neither is read: nothing here proves what a Pages Router file or plain JavaScript does.
  if (path.startsWith('src/pages/')) {
    return [{ path, line: 1, name: '(file)', problem: 'pages_router' }];
  }
  if (JAVASCRIPT.test(path)) {
    return [{ path, line: 1, name: '(file)', problem: 'javascript_source' }];
  }
  const facts = factsOf(path, text);
  const inline = inlineDirectives(facts, path);
  if (inline.length > 0) return inline;
  return [
    ...renderFindings(facts, path),
    ...actionFindings(facts, path),
    ...routeFindings(facts, path),
  ];
}

// Every source file under src, as a path from the app root.
export function sourceFiles(root: URL): readonly string[] {
  const src = fileURLToPath(new URL('src/', root));
  return readdirSync(src, { recursive: true, encoding: 'utf8' })
    .filter((path) => SOURCE.test(path))
    .map((path) => `src/${path}`)
    .sort();
}

export function checkTree(root: URL): readonly Finding[] {
  return sourceFiles(root).flatMap((path) =>
    checkSource(path, readFileSync(new URL(path, root), 'utf8')),
  );
}

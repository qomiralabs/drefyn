import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export type WalkerProblem =
  'guard_missing' | 'public_guard' | 'action_unwrapped' | 'route_unwrapped' | 'inline_use_server';

export interface Finding {
  readonly path: string;
  readonly line: number;
  readonly name: string;
  readonly problem: WalkerProblem;
}

type Guard = 'guardOrganization' | 'guardSignedIn' | 'guardPublic';

const ROUTE_FILE = /^src\/app\/(?:.*\/)?route\.tsx?$/;
const RENDER_FILE = /^src\/app\/(?:.*\/)?(?:page|layout|template|default)\.tsx?$/;
const RENDER_EXPORTS = new Set(['generateMetadata', 'generateViewport']);
const GET_LIKE = new Set(['GET', 'HEAD', 'OPTIONS']);
const ACTION_WRAPPERS = new Set(['publicAction', 'signedInAction', 'orgAction']);
const ROUTE_WRAPPERS = new Set(['publicRoute', 'signedInRoute', 'orgRoute']);
const GUARD_MODULE = /(?:^|\/)server\/guard(?:\.ts)?$/;
const WRAPPER_MODULE = /(?:^|\/)server\/actions(?:\.ts)?$/;

// The root layout wraps the 404 page too, so it can never hold a guard, and it reads nothing.
const UNGUARDED: ReadonlySet<string> = new Set(['src/app/layout.tsx']);
// Pages that hold no data. Each new one is a reviewed line here.
const PUBLIC_PAGES: ReadonlySet<string> = new Set(['src/app/bundle-baseline/page.tsx']);

function acceptedGuards(path: string): readonly Guard[] {
  if (path === 'src/app/page.tsx') return ['guardSignedIn'];
  if (path.startsWith('src/app/[org]/')) return ['guardOrganization'];
  return PUBLIC_PAGES.has(path) ? ['guardPublic'] : ['guardOrganization', 'guardSignedIn'];
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
      if (!GUARD_MODULE.test(from) && !WRAPPER_MODULE.test(from)) continue;
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
        const name = ts.isIdentifier(declaration.name) ? declaration.name.text : '(pattern)';
        entries.push({
          name,
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

// The guard a function runs before anything else, followed through helpers in this file.
// Only destructuring `await params` may come first; the one statement after it must begin
// by awaiting the guard with arguments that call nothing but `await params`.
function guardOf(
  facts: FileFacts,
  fn: FunctionNode | undefined,
  seen: ReadonlySet<FunctionNode> = new Set(),
): string | undefined {
  if (fn?.body === undefined || !ts.isBlock(fn.body) || seen.has(fn)) return undefined;
  const statement = fn.body.statements.find((s) => !isParamsAwait(s));
  if (statement === undefined) return undefined;
  if (
    !ts.isExpressionStatement(statement) &&
    !ts.isVariableStatement(statement) &&
    !ts.isReturnStatement(statement)
  ) {
    return undefined;
  }
  const call = firstCall(statement);
  if (call === undefined || !ts.isIdentifier(call.expression)) return undefined;
  if (!ts.isAwaitExpression(call.parent) || call.arguments.some(containsCall)) return undefined;
  const name = call.expression.text;
  if (declaresName(fn, name)) return undefined;
  const guard = facts.imported.get(name);
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

function renderFindings(facts: FileFacts, path: string): readonly Finding[] {
  if (!RENDER_FILE.test(path) || UNGUARDED.has(path)) return [];
  const accepted = acceptedGuards(path);
  const findings: Finding[] = [];
  for (const entry of exportsOf(facts)) {
    const render = entry.name === 'default' || entry.name === '*';
    if (!render && !RENDER_EXPORTS.has(entry.name)) continue;
    const guard = isFunctionNode(entry.value) ? guardOf(facts, entry.value) : undefined;
    if (accepted.some((name) => name === guard)) continue;
    const problem =
      guard === 'guardPublic' && !path.startsWith('src/app/[org]/') && path !== 'src/app/page.tsx'
        ? 'public_guard'
        : 'guard_missing';
    findings.push(findingAt(facts, path, entry.node, entry.name, problem));
  }
  return findings;
}

function actionFindings(facts: FileFacts, path: string): readonly Finding[] {
  if (!directivesOf(facts.source.statements).includes('use server')) return [];
  return exportsOf(facts)
    .filter((entry) => !ACTION_WRAPPERS.has(wrapperOf(facts, entry.value) ?? ''))
    .map((entry) => findingAt(facts, path, entry.node, entry.name, 'action_unwrapped'));
}

function routeFindings(facts: FileFacts, path: string): readonly Finding[] {
  if (!ROUTE_FILE.test(path)) return [];
  return exportsOf(facts)
    .filter((entry) => !GET_LIKE.has(entry.name))
    .filter((entry) => !ROUTE_WRAPPERS.has(wrapperOf(facts, entry.value) ?? ''))
    .map((entry) => findingAt(facts, path, entry.node, entry.name, 'route_unwrapped'));
}

// Reads one file. An inline directive is refused alone, because it makes an action no export
// shows and the rest of the file proves nothing about it.
export function checkSource(path: string, text: string): readonly Finding[] {
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
    .filter((path) => /\.tsx?$/.test(path))
    .map((path) => `src/${path}`)
    .sort();
}

export function checkTree(root: URL): readonly Finding[] {
  return sourceFiles(root).flatMap((path) =>
    checkSource(path, readFileSync(new URL(path, root), 'utf8')),
  );
}

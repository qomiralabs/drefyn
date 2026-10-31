import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

// Components that must render on the server with no JS. A name ending in * covers every
// export with that prefix, so new icons are held to the rule without editing this list.
export const SERVER_SAFE = [
  'Badge',
  'StatusPip',
  'StatusDot',
  'Skeleton',
  'EmptyState',
  'Button',
  'ButtonLink',
  'TextField',
  'Mark',
  'Icon*',
] as const;

// Anything from these packages holds state or effects, so it only runs on the client.
const CLIENT_ONLY_IMPORT =
  /^(?:react-aria-components|react-aria|react-stately|@react-aria\/|@react-stately\/)/;
// React's own hooks and every custom hook follow the useX naming rule; `use` alone is
// React 19's resource reader.
const HOOK = /^use(?:[A-Z0-9].*)?$/;

export const isServerSafe = (name: string): boolean =>
  SERVER_SAFE.some((entry) =>
    entry.endsWith('*') ? name.startsWith(entry.slice(0, -1)) : name === entry,
  );

export interface SplitFinding {
  file: string;
  detail: string;
}

// Relative path (with / separators) to source text, so fixtures can live as .txt files
// that neither tsc nor ESLint picks up.
export type SourceTree = ReadonlyMap<string, string>;

export function readTree(dir: string, strip = ''): SourceTree {
  const files = new Map<string, string>();
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const rel = relative(dir, full).split(sep).join('/');
      const name = strip !== '' && rel.endsWith(strip) ? rel.slice(0, -strip.length) : rel;
      if (/\.tsx?$/.test(name)) files.set(name, readFileSync(full, 'utf8'));
    }
  };
  walk(dir);
  return files;
}

const parse = (file: string, text: string) =>
  ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

// Next only honours the directive as the very first statement of the module.
function startsWithUseClient(source: ts.SourceFile): boolean {
  const first = source.statements[0];
  return (
    first !== undefined &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === 'use client'
  );
}

function hookCalls(source: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined;
      if (name !== undefined && HOOK.test(name)) found.push(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function moduleSpecifiers(source: ts.SourceFile): string[] {
  const specs: string[] = [];
  for (const statement of source.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specs.push(statement.moduleSpecifier.text);
    }
  }
  return specs;
}

// Exported name to the file it comes from, read from the barrel's named re-exports.
export function barrelExports(
  index: string,
  text: string,
): { exports: Map<string, string>; findings: SplitFinding[] } {
  const source = parse(index, text);
  const exports = new Map<string, string>();
  const findings: SplitFinding[] = [];
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier === undefined) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const spec = statement.moduleSpecifier.text;
    const clause = statement.exportClause;
    if (clause === undefined || !ts.isNamedExports(clause)) {
      findings.push({
        file: index,
        detail: `export * from '${spec}' hides which file each export comes from; name them`,
      });
      continue;
    }
    for (const element of clause.elements) {
      exports.set(element.name.text, spec.replace(/^\.\//, ''));
    }
  }
  return { exports, findings };
}

// The rules the Next App Router enforces at build time, checked per file so a failure
// names the file instead of a route.
export function checkSplit(tree: SourceTree, index = 'index.ts'): SplitFinding[] {
  const findings: SplitFinding[] = [];
  const client = new Set<string>();
  for (const [file, text] of tree) {
    const source = parse(file, text);
    const directive = startsWithUseClient(source);
    if (directive) client.add(file);
    if (file === index) {
      if (directive) {
        findings.push({
          file,
          detail:
            "the barrel must not start with 'use client'; every export would become a client component",
        });
      }
      continue;
    }
    if (directive) continue;
    for (const hook of new Set(hookCalls(source))) {
      findings.push({ file, detail: `calls ${hook} without 'use client' as its first statement` });
    }
    for (const spec of moduleSpecifiers(source).filter((s) => CLIENT_ONLY_IMPORT.test(s))) {
      findings.push({
        file,
        detail: `imports ${spec} without 'use client' as its first statement`,
      });
    }
  }
  const barrel = tree.get(index);
  if (barrel !== undefined) {
    const { exports, findings: barrelFindings } = barrelExports(index, barrel);
    findings.push(...barrelFindings);
    for (const [name, file] of exports) {
      if (isServerSafe(name) && client.has(file)) {
        findings.push({
          file,
          detail: `exports ${name}, which is server safe, but starts with 'use client'`,
        });
      }
    }
  }
  return findings;
}

import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { sourceFiles } from './support/walker.ts';

const root = new URL('../', import.meta.url);
const files = sourceFiles(root);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

interface Edge {
  readonly from: string;
  readonly to: string;
}

// Value imports only: a type import is erased, so it can never load mail code.
function importsOf(path: string): readonly string[] {
  const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const { moduleSpecifier } = statement;
    if (moduleSpecifier === undefined || !ts.isStringLiteral(moduleSpecifier)) continue;
    const clause = ts.isImportDeclaration(statement) ? statement.importClause : undefined;
    const typeOnly = ts.isImportDeclaration(statement)
      ? clause?.phaseModifier === ts.SyntaxKind.TypeKeyword ||
        (clause?.name === undefined &&
          clause?.namedBindings !== undefined &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.every((e) => e.isTypeOnly))
      : statement.isTypeOnly;
    if (!typeOnly) found.push(moduleSpecifier.text);
  }
  return found;
}

const local = (from: string, to: string) =>
  to.startsWith('.') ? posix.normalize(posix.join(posix.dirname(from), to)) : to;

const edges: readonly Edge[] = files.flatMap((from) =>
  importsOf(from).map((to) => ({ from, to: local(from, to) })),
);

describe('the mail seam', () => {
  it('has one statement that loads the package', () => {
    const named = files.filter((f) => /['"]@drefyn\/email['"]\)/.test(read(f)));
    expect(named).toEqual(['src/server/email-runtime.ts']);
    expect(read('src/server/email-runtime.ts')).toContain('turbopackIgnore: true');
  });

  it('imports no value of the package anywhere', () => {
    expect(edges.filter((e) => e.to === '@drefyn/email')).toEqual([]);
  });

  it('is reached only from the adapter', () => {
    const callers = edges.filter((e) => e.to === 'src/server/email-runtime.ts').map((e) => e.from);
    expect(callers).toEqual(['src/server/auth-mailer.ts']);
  });

  it('takes the config subpath and nothing else of the package', () => {
    const others = edges.filter((e) => e.to.startsWith('@drefyn/email/')).map((e) => e.to);
    expect(new Set(others)).toEqual(new Set(['@drefyn/email/config']));
  });

  it('is out of reach of every client file', () => {
    const clients = files.filter((f) => /^['"]use client['"]/m.test(read(f)));
    const reached = new Set<string>(clients);
    for (let grew = true; grew;) {
      grew = false;
      for (const { from, to } of edges) {
        if (reached.has(from) && !reached.has(to)) {
          reached.add(to);
          grew = true;
        }
      }
    }
    for (const seam of ['src/server/email-runtime.ts', 'src/server/auth-mailer.ts']) {
      expect(reached.has(seam), seam).toBe(false);
    }
    expect(reached.has('@drefyn/email/config')).toBe(false);
  });
});

// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Stories show what a consumer can import: the component entry, and the token entry for
// the values a foundations story prints. A deep path would test something nobody can
// import, and the package name would resolve through node_modules instead of the source.
const ENTRIES = new Set(['../src/react/index.ts', '../src/index.ts']);

function badImports(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const bad: string[] = [];
  const check = (spec: string) => {
    const local = spec.startsWith('.') || spec.startsWith('@drefyn/');
    if (local && !ENTRIES.has(spec)) bad.push(spec);
  };
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      check(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      check(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bad;
}

const fixture = (name: string) =>
  readFileSync(join(root, 'test', 'fixtures', 'stories', `${name}.stories.tsx.txt`), 'utf8');

describe('story imports', () => {
  it('reject a deep import into src', () => {
    expect(badImports('deep.stories.tsx', fixture('deep-import'))).toEqual([
      '../src/react/badge.tsx',
    ]);
  });

  it('reject the package name', () => {
    expect(badImports('pkg.stories.tsx', fixture('package-import'))).toEqual(['@drefyn/ui/react']);
  });

  it('reject a dynamic deep import', () => {
    expect(badImports('dyn.stories.tsx', "void import('../src/tokens/tokens.ts');")).toEqual([
      '../src/tokens/tokens.ts',
    ]);
  });

  it('accept the two public entries and outside packages', () => {
    expect(badImports('valid.stories.tsx', fixture('valid'))).toEqual([]);
  });

  it('hold for every story in the package', () => {
    const dir = join(root, 'stories');
    const stories = readdirSync(dir).filter((name) => name.endsWith('.stories.tsx'));
    expect(stories.length).toBeGreaterThan(0);
    for (const name of stories) {
      expect(badImports(name, readFileSync(join(dir, name), 'utf8')), name).toEqual([]);
    }
  });
});

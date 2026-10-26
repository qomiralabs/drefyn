import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const REACT = /^(?:react|react-dom)(?:\/|$)/;

// Every file reachable from an entry through static and dynamic imports, plus every bare
// specifier it names. Node refuses .tsx under type stripping, so one would break every
// token only consumer.
function graph(entry: string): { files: string[]; packages: string[] } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || files.has(file)) continue;
    files.add(file);
    if (extname(file) === '.css' || extname(file) === '.json') continue;
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);
    const specs: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        specs.push(node.moduleSpecifier.text);
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] !== undefined &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        specs.push(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const spec of specs) {
      if (spec.startsWith('.')) queue.push(resolve(dirname(file), spec));
      else packages.add(spec);
    }
  }
  return {
    files: [...files].map((file) => relative(root, file)).sort(),
    packages: [...packages].sort(),
  };
}

describe('the token entry', () => {
  const { files, packages } = graph(join(root, 'src', 'index.ts'));

  it('reaches no .tsx file', () => {
    expect(files.length).toBeGreaterThan(1);
    expect(files.filter((file) => file.endsWith('.tsx') || file.endsWith('.jsx'))).toEqual([]);
  });

  it('imports no React', () => {
    expect(packages.filter((spec) => REACT.test(spec))).toEqual([]);
  });

  it('never reaches the component entry', () => {
    expect(files.filter((file) => file.startsWith(join('src', 'react')))).toEqual([]);
  });

  it('runs in plain Node under type stripping', () => {
    const out = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "const ui = await import('@drefyn/ui'); console.log(typeof ui.tokens, typeof ui.themeScript);",
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(out.trim()).toBe('object string');
  });
});

describe('the component entry', () => {
  const resolveFrom = (spec: string) =>
    execFileSync(
      process.execPath,
      ['--input-type=module', '-e', `console.log(import.meta.resolve(${JSON.stringify(spec)}))`],
      { cwd: root, encoding: 'utf8' },
    ).trim();

  it('resolves @drefyn/ui/react and @drefyn/ui/react.css through the exports map', () => {
    expect(resolveFrom('@drefyn/ui/react')).toBe(
      pathToFileURL(join(root, 'src', 'react', 'index.ts')).href,
    );
    expect(resolveFrom('@drefyn/ui/react.css')).toBe(
      pathToFileURL(join(root, 'src', 'react', 'react.css')).href,
    );
  });

  it("does not start with 'use client', so server safe exports stay server components", () => {
    const file = join(root, 'src', 'react', 'index.ts');
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);
    const first = source.statements[0];
    const directive =
      first !== undefined &&
      ts.isExpressionStatement(first) &&
      ts.isStringLiteral(first.expression) &&
      first.expression.text === 'use client';
    expect(directive).toBe(false);
  });

  it("lets an app's Tailwind see the component classes", () => {
    const css = readFileSync(join(root, 'src', 'react', 'react.css'), 'utf8');
    expect(css).toContain('@source "./";');
  });
});

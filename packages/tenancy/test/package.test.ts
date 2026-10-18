import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as tenancy from '../src/index.ts';
import config from '../vitest.config.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  });
}

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  bundledDependencies?: unknown;
  exports: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Manifest;

// Every module specifier and require style call in a file, read by the TypeScript parser.
function specifiers(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const found = ts.preProcessFile(text, true, true).importedFiles.map((f) => f.fileName);
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sourceFile);
      if (/(^|\.)(require|getBuiltinModule)$/.test(callee) || callee === 'import') {
        const [arg] = node.arguments;
        found.push(arg && ts.isStringLiteralLike(arg) ? arg.text : `<computed in ${callee}>`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

describe('package shape', () => {
  it('has no runtime dependencies of any kind', () => {
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(manifest.peerDependencies ?? {}).toEqual({});
    expect(manifest.optionalDependencies ?? {}).toEqual({});
    expect(manifest.bundledDependencies).toBeUndefined();
  });

  it('has one public entry point', () => {
    expect(manifest.exports).toEqual({ '.': './src/index.ts', './package.json': './package.json' });
  });

  it('imports nothing but node:crypto and its own src files', () => {
    const files = sourceFiles(src);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.endsWith('.ts'), `${relative(root, file)} is not TypeScript`).toBe(true);
      for (const spec of specifiers(file)) {
        if (spec === 'node:crypto') continue;
        const local = spec.startsWith('./') || spec.startsWith('../');
        expect(local, `${relative(root, file)} imports '${spec}'`).toBe(true);
        expect(resolve(dirname(file), spec).startsWith(src + sep)).toBe(true);
      }
    }
  });

  it('sets line coverage to at least 95 percent in its own vitest config', () => {
    const { test } = config as { test?: { coverage?: { thresholds?: { lines?: unknown } } } };
    const lines = test?.coverage?.thresholds?.lines;
    expect(typeof lines).toBe('number');
    expect(lines).toBeGreaterThanOrEqual(95);
  });

  it('exports exactly the public API and no unvalidated way to brand a string', () => {
    expect(Object.keys(tenancy).sort()).toEqual(
      [
        'ID_KINDS',
        'TenancyError',
        'cacheKey',
        'idOf',
        'organizationId',
        'parsePublicId',
        'projectId',
        'surrogateKey',
        'toPublicId',
      ].sort(),
    );
  });

  it('documents the public API and that no other package defines these types', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    for (const name of [
      'OrganizationId',
      'ProjectId',
      'OrganizationRef',
      'TenantRef',
      'CacheKey',
      'cacheKey',
      'surrogateKey',
      'toPublicId',
      'parsePublicId',
      'ID_MALFORMED',
      'ID_WRONG_TYPE',
    ]) {
      expect(readme, `README mentions ${name}`).toContain(name);
    }
    expect(readme).toMatch(/no other package/i);
    expect(readme).not.toContain('One or two sentences on what this package does');
  });
});

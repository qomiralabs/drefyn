import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as seal from '../src/index.ts';
import config from '../vitest.config.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');

interface Manifest {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  bundledDependencies?: unknown;
  exports: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Manifest;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  });
}

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

// Auth and the AI keyring both sit above this package; a dependency back on either would
// pull one into the other.
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

  it('exports exactly the public API', () => {
    expect(Object.keys(seal).sort()).toEqual(
      [
        'MAX_SEAL_KEYS',
        'MIN_SEAL_KEY_BYTES',
        'SEAL_KEY_ID',
        'SealError',
        'aesGcmSealer',
        'lengthPrefixed',
      ].sort(),
    );
  });

  it('documents every export in the README', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    for (const name of Object.keys(seal)) expect(readme).toContain(`\`${name}`);
  });
});

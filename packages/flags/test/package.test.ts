import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as main from '../src/index.ts';
import * as testing from '../src/testing.ts';
import config from '../vitest.config.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const testingEntry = join(src, 'testing.ts');
const repo = resolve(root, '..', '..');

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
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

interface Manifest {
  name: string;
  private?: boolean;
  exports: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Manifest;
const productionFiles = filesUnder(src).filter((file) => file !== testingEntry);

describe('the testing entry point', () => {
  it('is listed explicitly in the exports map, next to the main entry', () => {
    expect(manifest.exports).toEqual({
      '.': './src/index.ts',
      './testing': './src/testing.ts',
      './package.json': './package.json',
    });
  });

  it('is imported by no other file under src', () => {
    expect(productionFiles.length).toBeGreaterThan(0);
    for (const file of productionFiles) {
      for (const spec of specifiers(file)) {
        const where = relative(root, file);
        expect(spec, `${where} imports '${spec}'`).not.toMatch(/^@drefyn\/flags\/testing/);
        expect(spec, `${where} imports '${spec}'`).not.toMatch(/^<computed/);
        if (spec.startsWith('.')) {
          const target = resolve(dirname(file), spec);
          expect(target.replace(/\.ts$/, ''), `${where} imports '${spec}'`).not.toBe(
            testingEntry.replace(/\.ts$/, ''),
          );
        }
      }
    }
  });

  // A type may name the key (the error key union does); no value may, so no production
  // path reads it from an environment object. The behaviour tests cover the client itself.
  it('is the only file under src that uses DREFYN_RELEASE_FLAGS as a value', () => {
    const uses: string[] = [];
    for (const file of productionFiles) {
      const text = readFileSync(file, 'utf8');
      const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        const named =
          (ts.isStringLiteralLike(node) || ts.isIdentifier(node)) &&
          node.text.includes('RELEASE_FLAGS');
        if (named && !ts.isLiteralTypeNode(node.parent)) {
          uses.push(`${relative(root, file)} at ${String(node.getStart())}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    expect(uses).toEqual([]);
  });

  it('is not re-exported from the main entry', () => {
    expect(Object.keys(main)).not.toContain('releaseFlagsFromEnv');
    expect(Object.keys(main)).not.toContain('createTestFlagClient');
    expect(Object.keys(testing).sort()).toEqual(['createTestFlagClient', 'releaseFlagsFromEnv']);
  });
});

describe('the main entry', () => {
  it('exports exactly the public API', () => {
    expect(Object.keys(main).sort()).toEqual(
      [
        'DEFAULT_EVAL_TIMEOUT_MS',
        'DEFAULT_FLAGD_SYNC_PORT',
        'DEFAULT_FLAGS_FILE',
        'DEFAULT_INIT_TIMEOUT_MS',
        'FLAG_AREAS',
        'FLAG_KINDS',
        'FlagError',
        'createFlagClient',
        'defineFlags',
        'flags',
        'loadFlagConfig',
      ].sort(),
    );
  });
});

describe('the provider stays in process', () => {
  it('no file under src names the RPC resolver or a port other than the sync port', () => {
    for (const file of filesUnder(src)) {
      const text = readFileSync(file, 'utf8');
      expect(text, relative(root, file)).not.toMatch(/['"`]rpc['"`]/);
      expect(text, relative(root, file)).not.toMatch(/\b8013\b/);
    }
  });

  it('one file builds the flagd provider, so no second path can pick a resolver', () => {
    const importers = productionFiles.filter((file) =>
      specifiers(file).includes('@openfeature/flagd-provider'),
    );
    expect(importers.map((file) => relative(root, file))).toHaveLength(1);
  });
});

describe('dependencies', () => {
  it('are pinned to exact versions or the workspace', () => {
    for (const field of ['dependencies', 'devDependencies'] as const) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        expect(range, `${field}.${name}`).toMatch(/^(workspace:\*|\d+\.\d+\.\d+)$/);
      }
    }
    expect(manifest.peerDependencies ?? {}).toEqual({});
    expect(manifest.optionalDependencies ?? {}).toEqual({});
  });

  it('are exactly the OpenFeature SDK, the flagd provider with its peers, entitlements and tenancy', () => {
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(
      [
        '@drefyn/entitlements',
        '@drefyn/tenancy',
        '@grpc/grpc-js',
        '@openfeature/core',
        '@openfeature/flagd-provider',
        '@openfeature/server-sdk',
      ].sort(),
    );
    expect(manifest.dependencies?.['@openfeature/server-sdk']).toBe('1.23.0');
    expect(manifest.dependencies?.['@openfeature/flagd-provider']).toBe('0.17.0');
  });

  it('point one way: entitlements never depends on flags', () => {
    const entitlements = join(repo, 'packages', 'entitlements');
    const other = JSON.parse(readFileSync(join(entitlements, 'package.json'), 'utf8')) as Manifest;
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
      expect(Object.keys(other[field] ?? {}), field).not.toContain('@drefyn/flags');
    }
    for (const file of filesUnder(join(entitlements, 'src'))) {
      for (const spec of specifiers(file)) expect(spec).not.toMatch(/^@drefyn\/flags/);
    }
  });
});

describe('coverage', () => {
  it('requires at least 95 percent of lines, since a gap here can ship an unreleased feature', () => {
    const { test } = config as { test?: { coverage?: { thresholds?: { lines?: unknown } } } };
    const lines = test?.coverage?.thresholds?.lines;
    expect(typeof lines).toBe('number');
    expect(lines).toBeGreaterThanOrEqual(95);
  });
});

describe('README', () => {
  it('documents the public API, the testing entry, the config keys and the error codes', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    for (const name of [
      'defineFlags',
      'createFlagClient',
      'loadFlagConfig',
      'isOn',
      'evaluate',
      'safeValue',
      'releaseFlagsFromEnv',
      'createTestFlagClient',
      '@drefyn/flags/testing',
      'DREFYN_RELEASE_FLAGS',
      'DREFYN_FLAGS_SOURCE',
      'DREFYN_FLAGS_FILE',
      'DREFYN_FLAGD_HOST',
      'DREFYN_FLAGD_SYNC_PORT',
      'DREFYN_FLAGS_EVAL_TIMEOUT_MS',
      'DREFYN_FLAGS_INIT_TIMEOUT_MS',
      'FLAG_CONFIG_INVALID',
      'FLAG_DEFINITION_INVALID',
      'FLAG_TIMEOUT',
      'FLAG_PROVIDER_NOT_READY',
      'flags.provider_not_ready',
      'flags_provider_ready',
      'flags_last_sync_age_seconds',
      'flags_evaluation_ms',
    ]) {
      expect(readme, `README mentions ${name}`).toContain(name);
    }
    expect(readme).not.toContain('One or two sentences on what this package does');
  });
});

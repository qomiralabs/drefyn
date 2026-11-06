import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as main from '../src/index.ts';
import * as client from '../src/client.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = resolve(root, '../..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  exports: Record<string, string>;
};

// The worker file is named in a URL and not imported, which is the point: it runs only in a
// thread. Type only imports load nothing.
const STATEMENT = /^(?:(?:import|export)\s(?!type\b)[^;]*?from\s+|import\s+)'(\.[^']+)';/gm;
const imports = (file: string) =>
  [...readFileSync(file, 'utf8').matchAll(STATEMENT)].flatMap(([, spec]) =>
    spec === undefined ? [] : [resolve(dirname(file), spec)],
  );

function reach(entry: string): Set<string> {
  const seen = new Set<string>();
  const pending = [entry];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    pending.push(...imports(file));
  }
  return seen;
}

const SKIPPED = new Set(['node_modules', 'coverage', 'dist', '.next', '.turbo']);
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIPPED.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name) ? [path] : [];
  });
}

describe('the way into the parser', () => {
  it('is not exported to any caller', () => {
    expect(Object.keys(main).sort()).toEqual([
      'AST_VERSION',
      'DEFAULT_LIMITS',
      'rawOf',
      'readerBlocks',
      'validateTree',
    ]);
    expect(Object.keys(client)).toEqual(['createParseClient']);
  });

  it('is limited to these entries', () => {
    expect(Object.keys(manifest.exports).sort()).toEqual(['.', './client', './package.json']);
  });

  it('is out of the import graph of every exported entry', () => {
    const parser = join(root, 'src/parse.ts');
    const pool = join(root, 'src/pool.ts');
    const printer = join(root, 'src/print.ts');
    for (const target of Object.values(manifest.exports)) {
      if (!target.endsWith('.ts')) continue;
      const graph = reach(join(root, target));
      expect(graph.size).toBeGreaterThan(1);
      expect(graph).not.toContain(parser);
      expect(graph).not.toContain(pool);
      expect(graph).not.toContain(printer);
    }
  });

  it('is named by no code outside this package', () => {
    const files = [...sources(join(workspace, 'apps')), ...sources(join(workspace, 'packages'))];
    const callers = files
      .filter((file) => !file.startsWith(`${root}/`))
      .filter((file) => /\b(?:parseForStore|printCanonical)\b/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(workspace, file));
    expect(callers).toEqual([]);
  });
});

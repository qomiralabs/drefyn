import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as main from '../src/index.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  exports: Record<string, string>;
  drefyn?: { pureEntries?: string[] };
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

describe('package layout', () => {
  it('has one entry, marked pure, so it loads where Node is absent', () => {
    expect(manifest.exports).toEqual({
      '.': './src/index.ts',
      './package.json': './package.json',
    });
    expect(manifest.drefyn?.pureEntries).toEqual(['.']);
  });

  it('has no runtime dependencies', () => {
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.peerDependencies).toBeUndefined();
  });

  it('imports nothing at all from src', () => {
    for (const file of readdirSync(src).filter((f) => f.endsWith('.ts'))) {
      const imported = ts
        .preProcessFile(readFileSync(join(src, file), 'utf8'), true, true)
        .importedFiles.map((f) => f.fileName)
        .filter((spec) => !spec.startsWith('./'));
      expect(imported, file).toEqual([]);
    }
  });

  it('exports exactly the public API', () => {
    expect(Object.keys(main).sort()).toEqual(['isNormalizedEmailAddress', 'normalizeEmailAddress']);
  });
});

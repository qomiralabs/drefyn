import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as main from '../src/index.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string;
  exports: Record<string, string>;
  dependencies?: Record<string, string>;
};

describe('package layout', () => {
  it('is the @drefyn/egress package the lint rule exempts, with one entry', () => {
    expect(manifest.name).toBe('@drefyn/egress');
    expect(manifest.exports).toEqual({ '.': './src/index.ts', './package.json': './package.json' });
  });

  it('has no runtime dependencies: Node is the only network stack it trusts', () => {
    expect(manifest.dependencies).toBeUndefined();
  });

  it('exports exactly the public API', () => {
    expect(Object.keys(main).sort()).toEqual([
      'EGRESS_PURPOSES',
      'guardedConnect',
      'guardedFetch',
      'guardedResolve',
      'policyFor',
    ]);
  });
});

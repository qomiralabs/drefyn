import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../next.config.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const lockfile = read('../../../pnpm-lock.yaml');
const manifest = JSON.parse(read('../package.json')) as {
  dependencies: Record<string, string>;
};

describe('the install tree', () => {
  it('has no sharp and no @img binaries, only the override that removes them', () => {
    const lines = lockfile.split('\n');
    const mentions = lines.filter((line) => /(^|[\s'"/])(sharp|@img\/)/.test(line));
    expect(mentions).toEqual(["  sharp: '-'"]);
  });

  it('pins the framework exactly', () => {
    expect(manifest.dependencies).toMatchObject({
      next: '16.4.2',
      react: '19.3.1',
      'react-dom': '19.3.1',
      motion: '14.4.0',
    });
  });
});

describe('next.config', () => {
  it('serves images unoptimized, so nothing asks for sharp at run time', () => {
    expect(config.images?.unoptimized).toBe(true);
  });

  it('compiles the ui package from source', () => {
    expect(config.transpilePackages).toContain('@drefyn/ui');
  });
});

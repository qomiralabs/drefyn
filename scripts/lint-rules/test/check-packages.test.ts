import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/check-packages.ts';
import { goodPackage, tempWorkspace, type TempWorkspace } from './helpers.ts';

let ws: TempWorkspace;
let out: string;
let err: string;
const io = {
  out: (text: string) => {
    out += text;
  },
  err: (text: string) => {
    err += text;
  },
};

beforeEach(() => {
  ws = tempWorkspace();
  out = '';
  err = '';
});
afterEach(() => {
  ws.cleanup();
});

describe('check-packages cli', () => {
  it('exits 0 and says what it checked on a clean workspace', () => {
    ws.manifest('packages/a', goodPackage('a'));
    ws.write('packages/a/src/index.ts', 'export const a = 1;\n');
    expect(main(['--root', ws.root], io)).toBe(0);
    expect(out).toBe('check:packages: clean (1 packages, 1 source files)\n');
    expect(err).toBe('');
  });

  it('exits 1 and lists each problem', () => {
    ws.manifest('packages/a', goodPackage('b', { type: 'commonjs' }));
    expect(main(['--root', ws.root], io)).toBe(1);
    expect(err).toBe(
      "packages/a (@drefyn/b): name: must be '@drefyn/a'\n" +
        "packages/a (@drefyn/b): type: must be 'module', found 'commonjs'\n" +
        'check:packages: 2 problems\n',
    );
  });

  it('finds the workspace root from the working directory by default', () => {
    ws.manifest('packages/a', goodPackage('a'));
    const before = process.cwd();
    process.chdir(join(ws.root, 'packages/a'));
    try {
      expect(main([], io)).toBe(0);
    } finally {
      process.chdir(before);
    }
  });

  it('exits 2 on a bad flag or when there is no workspace', () => {
    expect(main(['--nope'], io)).toBe(2);
    const empty = mkdtempSync(join(tmpdir(), 'drefyn-no-workspace-'));
    try {
      expect(main(['--root', empty], io)).toBe(2);
      expect(err).toContain('check:packages: error: no pnpm-workspace.yaml');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('prints usage on --help', () => {
    expect(main(['--help'], io)).toBe(0);
    expect(out).toContain('usage: check-packages');
  });
});

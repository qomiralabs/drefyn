import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/check-packages.ts';
import {
  GIT_INIT_HOOK_TIMEOUT_MS,
  goodPackage,
  repoRoot,
  tempWorkspace,
  type TempWorkspace,
} from './helpers.ts';

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
}, GIT_INIT_HOOK_TIMEOUT_MS);
afterEach(() => {
  ws.cleanup();
});

describe('check-packages cli', () => {
  it('exits 0 and says what it checked on a clean workspace', () => {
    ws.manifest('packages/a', goodPackage('a'));
    ws.write('packages/a/src/index.ts', 'export const a = 1;\n');
    expect(main(['--root', ws.root], io)).toBe(0);
    expect(out).toBe(
      'check:packages: clean (1 workspace package, 1 under packages/ and apps/, 1 source file)\n',
    );
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

  it('says problem for a single finding', () => {
    ws.manifest('packages/a', goodPackage('b'));
    expect(main(['--root', ws.root], io)).toBe(1);
    expect(err).toBe(
      "packages/a (@drefyn/b): name: must be '@drefyn/a'\ncheck:packages: 1 problem\n",
    );
  });

  it('exits 2 when pnpm-workspace.yaml lists no packages', () => {
    ws.write('pnpm-workspace.yaml', 'packages:\nminimumReleaseAge: 1\n');
    expect(main(['--root', ws.root], io)).toBe(2);
    expect(err).toBe('check:packages: error: pnpm-workspace.yaml: no packages list\n');
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

  describe('the next version floor', () => {
    const lockfile = (...versions: string[]) =>
      [
        "lockfileVersion: '9.0'",
        '',
        'packages:',
        '',
        ...versions.flatMap((version) => [
          `  ${version}:`,
          '    resolution: {integrity: sha512-x}',
          '',
        ]),
        'snapshots:',
        '',
      ].join('\n');

    const run = (text: string) => {
      ws.manifest('packages/a', goodPackage('a'));
      ws.write('packages/a/src/index.ts', 'export const a = 1;\n');
      ws.write('pnpm-lock.yaml', text);
      return main(['--root', ws.root], io);
    };

    it('fails on a lockfile resolving 16.4.0', () => {
      expect(run(lockfile('next@16.4.0'))).toBe(1);
      expect(err).toContain('pnpm-lock.yaml: next: resolved 16.4.0 is below the 16.4.1 floor');
    });

    it.each(['next@16.4.1-canary.3', 'next@15.9.9', 'next@9.0.0', "'next@16.3.99'"])(
      'fails on %s',
      (version) => {
        expect(run(lockfile(version))).toBe(1);
      },
    );

    it('fails when any one of several resolved versions is low', () => {
      expect(run(lockfile('next@16.4.2', 'next@16.4.0'))).toBe(1);
    });

    it('fails on a version it cannot read', () => {
      expect(run(lockfile('next@latest'))).toBe(1);
      expect(err).toContain('pnpm-lock.yaml: next: cannot read version latest');
    });

    it.each(['next@16.4.1', 'next@16.4.2', 'next@16.5.0', 'next@17.0.0'])(
      'passes %s',
      (version) => {
        expect(run(lockfile(version))).toBe(0);
      },
    );

    it('leaves packages with similar names alone', () => {
      expect(run(lockfile('next-themes@0.2.0', '@next/env@1.0.0', 'nextra@2.0.0'))).toBe(0);
    });

    it('holds the repo lockfile to the floor', () => {
      expect(main(['--root', repoRoot], io)).toBe(0);
    });
  });
});

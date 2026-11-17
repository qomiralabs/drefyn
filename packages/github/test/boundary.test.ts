import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as github from '../src/index.ts';

const root = resolve(import.meta.dirname, '..', '..', '..');

interface Report {
  readonly messages: readonly { readonly ruleId: string | null; readonly message: string }[];
}

// The same ESLint run and config the gate's boundary guard uses, on one file read from stdin.
function guard(filename: string, source: string): Report {
  const result = spawnSync(
    process.execPath,
    [
      join(root, 'node_modules', 'eslint', 'bin', 'eslint.js'),
      '--no-config-lookup',
      '--config',
      join(root, 'scripts', 'lint-rules', 'guard.config.js'),
      '--no-inline-config',
      '--no-ignore',
      '--format',
      'json',
      '--stdin',
      '--stdin-filename',
      filename,
    ],
    { cwd: root, input: source, encoding: 'utf8', timeout: 60_000 },
  );
  const parsed = JSON.parse(result.stdout) as readonly Report[];
  const report = parsed[0];
  if (report === undefined) throw new Error(`no report: ${result.stderr}`);
  return report;
}

describe('the private key reader', () => {
  it.each([
    [
      'apps/api/src/probe.ts',
      "import { loadAppSigner } from '../../../packages/github/src/private-key.ts';",
    ],
    [
      'packages/git-sync/src/probe.ts',
      "import { loadAppSigner } from '@drefyn/github/src/private-key.ts';",
    ],
    [
      'packages/git-sync/src/probe.ts',
      "const m = await import('../../github/src/private-key.ts');",
    ],
  ])(
    'is refused by the boundary guard from %s',
    (filename, source) => {
      const report = guard(filename, `${source}\nexport {};\n`);
      expect(report.messages.map((m) => m.ruleId)).toContain('drefyn/no-cross-package-internals');
    },
    60_000,
  );

  it('is not exported, and the package has no entry but its index', () => {
    expect(Object.keys(github)).not.toContain('loadAppSigner');
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { exports: Record<string, string> };
    expect(manifest.exports).toEqual({ '.': './src/index.ts', './package.json': './package.json' });
  });

  it('is imported by the broker alone inside the package', () => {
    const src = join(import.meta.dirname, '..', 'src');
    const importers = readdirSync(src)
      .filter((file) => readFileSync(join(src, file), 'utf8').includes('private-key'))
      .filter((file) => file !== 'private-key.ts');
    expect(importers).toEqual(['broker.ts']);
  });
});

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkWorkspace, formatFinding } from '../src/manifest.ts';
import { repoRoot, tempWorkspace, type TempWorkspace } from './helpers.ts';

const template = join(repoRoot, 'templates/package');

describe('package template', () => {
  let ws: TempWorkspace | undefined;
  afterEach(() => {
    ws?.cleanup();
    ws = undefined;
  });

  it('has every required file', () => {
    const files = [
      'package.json',
      'README.md',
      'tsconfig.json',
      'vitest.config.ts',
      'src/index.ts',
      'test/index.test.ts',
    ];
    expect(files.filter((file) => !existsSync(join(template, file)))).toEqual([]);
  });

  it('passes the manifest checker once copied and named as the guide says', () => {
    ws = tempWorkspace();
    const target = join(ws.root, 'packages/example');
    cpSync(template, target, { recursive: true });
    for (const file of ['package.json', 'README.md', 'src/index.ts', 'test/index.test.ts']) {
      const path = join(target, file);
      writeFileSync(path, readFileSync(path, 'utf8').replaceAll('__name__', 'example'));
    }
    expect(checkWorkspace(ws.root).findings.map(formatFinding)).toEqual([]);
  });

  // Run as pnpm lint would, in a child process: loading the plugin natively inside the
  // test worker would also skew the coverage of the rule sources.
  it('passes the repository lint config with zero warnings', () => {
    const eslint = join(repoRoot, 'node_modules/.bin/eslint');
    const output = execFileSync(
      eslint,
      ['--max-warnings', '0', '--format', 'json', 'templates/package'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    );
    const results = JSON.parse(output) as { filePath: string; messages: unknown[] }[];
    expect(results.map((r) => relative(template, r.filePath)).sort()).toEqual([
      'src/index.ts',
      'test/index.test.ts',
      'vitest.config.ts',
    ]);
    expect(results.flatMap((r) => r.messages)).toEqual([]);
  });

  it('typechecks', () => {
    const tsc = join(repoRoot, 'node_modules/.bin/tsc');
    expect(() =>
      execFileSync(tsc, ['-p', join(template, 'tsconfig.json')], { encoding: 'utf8' }),
    ).not.toThrow();
  });
});

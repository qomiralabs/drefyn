import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { goodPackage, repoRoot, tempWorkspace, type TempWorkspace } from './helpers.ts';

const guard = join(repoRoot, 'scripts/lint-rules/guard.sh');
const NO_EGRESS = 'drefyn/' + 'no-raw-egress';
const NO_INTERNALS = 'drefyn/' + 'no-cross-package-internals';
const RAW = "export const f = fetch('x');\n";

let ws: TempWorkspace;
beforeEach(() => {
  ws = tempWorkspace();
  ws.write('.gitignore', 'node_modules/\ndist/\ncoverage/\n');
  ws.manifest('packages/a', goodPackage('a'));
  ws.write('packages/a/src/index.ts', 'export const a = 1;\n');
});
afterEach(() => {
  ws.cleanup();
});

interface Hit {
  file: string;
  line: number;
  rule: string | null;
}

// Runs the guard the way the gate does, in a child process, and returns each report.
function runGuard(): { status: number | null; hits: Hit[]; stderr: string } {
  execFileSync('git', ['add', '-A'], { cwd: ws.root });
  const result = spawnSync('bash', [guard, '--format', 'json'], {
    cwd: ws.root,
    encoding: 'utf8',
  });
  const parsed = JSON.parse(result.stdout || '[]') as {
    filePath: string;
    messages: { line: number; ruleId: string | null }[];
  }[];
  // git reports the real path, and the temp folder sits behind a symlink on macOS.
  const root = realpathSync(ws.root);
  const hits = parsed.flatMap((r) =>
    r.messages.map((m) => ({
      file: relative(root, r.filePath).split('\\').join('/'),
      line: m.line,
      rule: m.ruleId,
    })),
  );
  return { status: result.status, hits, stderr: result.stderr };
}

const egress = (file: string, line = 1): Hit => ({ file, line, rule: NO_EGRESS });

describe('guard on a clean tree', () => {
  it('passes, honours the shared allow list and skips the lint rule fixtures', () => {
    ws.manifest('scripts/review-gate', { name: '@drefyn/review-gate', private: true });
    ws.write('scripts/review-gate/src/github.ts', RAW);
    ws.write('scripts/lint-rules/test/fixtures/w/packages/web/src/raw.ts', RAW);
    const { status, hits, stderr } = runGuard();
    expect(stderr).toBe('');
    expect(hits).toEqual([]);
    expect(status).toBe(0);
  });
});

describe('guard exit codes', () => {
  it('passes ESLint through unchanged, so a crash reads 2 and not 123 from GNU xargs', () => {
    // A nested workspace file with no packages list makes the rule throw.
    ws.write('packages/a/src/x/pnpm-workspace.yaml', 'minimumReleaseAge: 1\n');
    ws.write('packages/a/src/x/raw.ts', RAW);
    ws.write('pnpm-workspace.yaml', 'minimumReleaseAge: 1\n');
    execFileSync('git', ['add', '-A'], { cwd: ws.root });
    const result = spawnSync('bash', [guard], { cwd: ws.root, encoding: 'utf8' });
    expect(result.stderr).toContain('pnpm-workspace.yaml: no packages list');
    expect(result.status).toBe(2);
  });

  it('fails when there are no source files, since this repo always has some', () => {
    const empty = tempWorkspace();
    try {
      const result = spawnSync('bash', [guard], { cwd: empty.root, encoding: 'utf8' });
      expect(result.stderr).toBe('guard: no source files found\n');
      expect(result.status).toBe(2);
    } finally {
      empty.cleanup();
    }
  });

  it('fails when git fails instead of linting nothing', () => {
    const broken = spawnSync('bash', [guard], {
      cwd: ws.root,
      encoding: 'utf8',
      env: { ...process.env, GIT_DIR: join(ws.root, 'missing') },
    });
    expect(broken.stderr).toContain('not a git repository');
    expect(broken.status).not.toBe(0);
    const outside = mkdtempSync(join(tmpdir(), 'drefyn-no-git-'));
    try {
      const result = spawnSync('bash', [guard], {
        cwd: outside,
        encoding: 'utf8',
        env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() },
      });
      expect(result.stderr).toContain('not a git repository');
      expect(result.status).not.toBe(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('skips a tracked file that was deleted from disk and still lints the rest', () => {
    ws.write('packages/a/src/gone.ts', RAW);
    ws.write('packages/a/src/raw.ts', RAW);
    execFileSync('git', ['add', '-A'], { cwd: ws.root });
    rmSync(join(ws.root, 'packages/a/src/gone.ts'));
    const result = spawnSync('bash', [guard, '--format', 'json'], {
      cwd: ws.root,
      encoding: 'utf8',
    });
    const files = (JSON.parse(result.stdout) as { filePath: string; messages: unknown[] }[])
      .filter((r) => r.messages.length > 0)
      .map((r) => relative(realpathSync(ws.root), r.filePath));
    expect(files).toEqual(['packages/a/src/raw.ts']);
    expect(result.status).toBe(1);
  });
});

describe('guard on file names and layouts it must not trust', () => {
  it('lints a root file named like an option instead of reading it as one', () => {
    ws.write('--config=evil.mjs', '');
    ws.write(
      'evil.mjs',
      "import tseslint from 'typescript-eslint';\nexport default [{ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } }];\n",
    );
    ws.write('shared/net.ts', RAW);
    const { status, hits } = runGuard();
    expect(hits).toEqual([egress('shared/net.ts')]);
    expect(status).toBe(1);
  });

  it('keeps the real root when a nested pnpm-workspace.yaml claims a packages/egress', () => {
    ws.write('packages/a/src/pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
    ws.manifest('packages/a/src/packages/egress', {
      name: '@drefyn/egress',
      private: true,
      type: 'module',
    });
    ws.write('packages/a/src/packages/egress/raw.ts', RAW);
    const { status, hits } = runGuard();
    expect(hits).toEqual([egress('packages/a/src/packages/egress/raw.ts')]);
    expect(status).toBe(1);
  });

  it('I6: fails on a committed source file under node_modules, which ESLint will not lint', () => {
    ws.write('packages/a/src/node_modules/x.ts', RAW);
    execFileSync('git', ['add', '--force', '--', 'packages/a/src/node_modules/x.ts'], {
      cwd: ws.root,
    });
    const result = spawnSync('bash', [guard], { cwd: ws.root, encoding: 'utf8' });
    expect(result.stdout).toContain('packages/a/src/node_modules/x.ts');
    expect(result.status).toBe(1);
  });

  it('I7: ignores a root eslint.config.js that ignores everything', () => {
    ws.write('eslint.config.js', "export default [{ ignores: ['**'] }];\n");
    ws.write('packages/a/src/raw.ts', RAW);
    const { status, hits } = runGuard();
    expect(hits).toEqual([egress('packages/a/src/raw.ts')]);
    expect(status).toBe(1);
  });

  it('leaves no temp file behind', () => {
    // A mktemp shim records every path the guard creates, wherever the platform puts it.
    const shim = mkdtempSync(join(tmpdir(), 'drefyn-guard-shim-'));
    try {
      const real = execFileSync('sh', ['-c', 'command -v mktemp'], { encoding: 'utf8' }).trim();
      const log = join(shim, 'made.log');
      writeFileSync(
        join(shim, 'mktemp'),
        `#!/bin/sh\np="$('${real}' "$@")" || exit $?\nprintf '%s\\n' "$p" >> '${log}'\nprintf '%s\\n' "$p"\n`,
        { mode: 0o755 },
      );
      const result = spawnSync('bash', [guard], {
        cwd: ws.root,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${shim}:${process.env['PATH'] ?? ''}` },
      });
      expect(result.status).toBe(0);
      const made = readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line !== '');
      expect(made.length).toBeGreaterThan(0);
      expect(made.filter((path) => existsSync(path))).toEqual([]);
    } finally {
      rmSync(shim, { recursive: true, force: true });
    }
  });

  // Temp repos lack the real layout, so a guard.sh edit keyed on a file that only the
  // real tree has would pass every other test here.
  it('I6: on a copy of the real tree, lints exactly its source files and reports a raw call', () => {
    const copy = mkdtempSync(join(tmpdir(), 'drefyn-guard-copy-'));
    try {
      const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
        .split('\0')
        .filter((file) => file !== '' && existsSync(join(repoRoot, file)));
      for (const file of tracked) {
        const from = join(repoRoot, file);
        mkdirSync(dirname(join(copy, file)), { recursive: true });
        // Copy a link as a link; the checker, not this test, refuses links.
        if (lstatSync(from).isSymbolicLink()) symlinkSync(readlinkSync(from), join(copy, file));
        else copyFileSync(from, join(copy, file));
      }
      execFileSync('git', ['init', '-q'], { cwd: copy });
      // A folder name the real tree cannot already hold.
      const probe = relative(copy, mkdtempSync(join(copy, 'guard-probe-')));
      writeFileSync(join(copy, probe, 'net.ts'), RAW);
      execFileSync('git', ['add', '-A'], { cwd: copy });
      const result = spawnSync('bash', [guard, '--format', 'json'], {
        cwd: copy,
        encoding: 'utf8',
      });
      const parsed = JSON.parse(result.stdout) as { filePath: string; messages: unknown[] }[];
      const real = realpathSync(copy);
      const linted = parsed.map((r) => relative(real, r.filePath)).sort();
      const sources = [...tracked, `${probe}/net.ts`]
        .filter(
          (file) =>
            /\.[cm]?[jt]sx?$/.test(file) && !file.startsWith('scripts/lint-rules/test/fixtures/'),
        )
        .sort();
      expect(linted).toEqual(sources);
      const flagged = parsed
        .filter((r) => r.messages.length > 0)
        .map((r) => relative(real, r.filePath));
      expect(flagged).toEqual([`${probe}/net.ts`]);
      expect(result.status).toBe(1);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });
});

describe('guard catches what per package lint can miss', () => {
  it.each(['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'])(
    'a nested eslint.config.%s that drops the rules for its folder',
    (ext) => {
      ws.write(`packages/a/src/sub/eslint.config.${ext}`, 'export default [];\n');
      ws.write('packages/a/src/sub/raw.ts', RAW);
      const { status, hits } = runGuard();
      expect(hits).toEqual([egress('packages/a/src/sub/raw.ts')]);
      expect(status).toBe(1);
    },
  );

  it('a config comment that turns a rule off with an escaped name', () => {
    ws.write(
      'packages/a/src/escaped.ts',
      `/* eslint "${NO_EGRESS.replace('-', '\\u002d')}": "off" */\n${RAW}`,
    );
    ws.write(
      'packages/a/src/escaped-internal.ts',
      `/* eslint "${NO_INTERNALS.replace('/', '\\/')}": "off" */\nexport * from '../../b/src/x.ts';\n`,
    );
    ws.manifest('packages/b', goodPackage('b'));
    const { status, hits } = runGuard();
    expect(hits).toEqual([
      { file: 'packages/a/src/escaped-internal.ts', line: 2, rule: NO_INTERNALS },
      egress('packages/a/src/escaped.ts', 2),
    ]);
    expect(status).toBe(1);
  });

  it('force added files under dist/ and coverage/', () => {
    ws.write('packages/a/src/dist/raw.ts', RAW);
    ws.write('packages/a/coverage/raw.js', RAW);
    execFileSync('git', ['add', '-f', 'packages/a/src/dist/raw.ts', 'packages/a/coverage/raw.js'], {
      cwd: ws.root,
    });
    const { status, hits } = runGuard();
    expect(hits).toEqual([
      egress('packages/a/coverage/raw.js'),
      egress('packages/a/src/dist/raw.ts'),
    ]);
    expect(status).toBe(1);
  });

  it('a disable comment under build/ or out/', () => {
    ws.write('packages/a/src/build/raw.ts', `// eslint-disable-next-line ${NO_EGRESS}\n${RAW}`);
    ws.write('packages/a/src/out/raw.ts', `/* eslint-disable */\n${RAW}`);
    const { status, hits } = runGuard();
    expect(hits).toEqual([
      egress('packages/a/src/build/raw.ts', 2),
      egress('packages/a/src/out/raw.ts', 2),
    ]);
    expect(status).toBe(1);
  });

  it('a root file outside every package, and the package that imports it', () => {
    ws.write('shared/net.ts', RAW);
    ws.write('packages/a/src/uses.ts', "export { f } from '../../../shared/net.ts';\n");
    const { status, hits } = runGuard();
    expect(hits).toEqual([egress('shared/net.ts')]);
    expect(status).toBe(1);
  });

  it('a package whose lint script does not run the rules', () => {
    ws.manifest(
      'packages/c',
      goodPackage('c', { scripts: { lint: 'echo eslint skipped', typecheck: 'true' } }),
    );
    ws.write('packages/c/src/index.ts', RAW);
    const { status, hits } = runGuard();
    expect(hits).toEqual([egress('packages/c/src/index.ts')]);
    expect(status).toBe(1);
  });

  it('a new file that is not committed yet', () => {
    ws.write('packages/a/src/new.ts', RAW);
    const result = spawnSync('bash', [guard], { cwd: ws.root, encoding: 'utf8' });
    expect(result.stdout).toContain('packages/a/src/new.ts');
    expect(result.status).toBe(1);
  });
});

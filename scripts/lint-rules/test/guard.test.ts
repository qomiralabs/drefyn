import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { goodPackage, repoRoot, tempWorkspace, type TempWorkspace } from './helpers.ts';

const guard = join(repoRoot, 'scripts/lint-rules/guard.sh');
const NO_EGRESS = 'drefyn/' + 'no-raw-egress';
const NO_INTERNALS = 'drefyn/' + 'no-cross-package-internals';
const RAW = "export const f = fetch('x');\n";

let ws: TempWorkspace;
beforeEach(() => {
  ws = tempWorkspace();
  execFileSync('git', ['init', '-q'], { cwd: ws.root });
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

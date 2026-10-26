import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkWorkspace,
  formatFinding,
  REVIEWED_PREFIXES,
  REVIEWED_ROOT_FILES,
} from '../src/manifest.ts';
import { goodPackage, repoRoot, SCRIPTS, tempWorkspace, type TempWorkspace } from './helpers.ts';

// The workspace hook runs git init, which kept the 10 s hook default while the tests got
// 60 s, and git init is what timed out. Over 30 runs with the process held to 0.5 percent
// of a CPU on a busy host it took 4.5 s median, over 10 s in 5 runs and 32 s at most (one
// further run stalled with the whole host); at 2 percent, 4.3 s at most. 60 s matches the
// test timeout and is 1.9 times the 0.5 percent maximum.
const GIT_INIT_HOOK_TIMEOUT_MS = 60_000;

let ws: TempWorkspace;
beforeEach(() => {
  ws = tempWorkspace();
}, GIT_INIT_HOOK_TIMEOUT_MS);
afterEach(() => {
  ws.cleanup();
});

const check = () => checkWorkspace(ws.root).findings.map(formatFinding);

// Rule names are split so this file never holds a real directive for the scanner to find.
const NO_INTERNALS = 'drefyn/' + 'no-cross-package-internals';
const NO_EGRESS = 'drefyn/' + 'no-raw-egress';

describe('manifest checker on valid packages', () => {
  it('passes a private source package, an app and explicit subpaths', () => {
    ws.manifest('packages/a', goodPackage('a'));
    ws.manifest(
      'packages/ui',
      goodPackage('ui', {
        exports: {
          '.': './src/index.ts',
          './tokens.css': './src/tokens.css',
          './testing': './src/testing.ts',
          './package.json': './package.json',
        },
      }),
    );
    ws.manifest('apps/web', goodPackage('web', { dependencies: { '@drefyn/a': 'workspace:*' } }));
    expect(check()).toEqual([]);
    expect(checkWorkspace(ws.root).packages).toBe(3);
  });

  it('passes a published package that builds to dist and depends on npm only', () => {
    ws.manifest('packages/sdk', {
      name: '@drefyn/sdk',
      scripts: SCRIPTS,
      version: '0.1.0',
      type: 'module',
      exports: {
        '.': { types: './dist/index.d.ts', default: './dist/index.js' },
        './package.json': './package.json',
      },
      dependencies: { zod: '4.0.0' },
      devDependencies: { '@drefyn/a': 'workspace:*' },
    });
    ws.manifest('packages/a', goodPackage('a'));
    expect(check()).toEqual([]);
  });

  it('does not hold scripts packages to the package layout', () => {
    ws.manifest('scripts/tool', { name: '@drefyn/tool', private: true, type: 'module' });
    expect(check()).toEqual([]);
  });

  it('passes this repository', () => {
    expect(checkWorkspace(repoRoot).findings.map(formatFinding)).toEqual([]);
  });
});

describe('manifest checker failures name the package and the field', () => {
  it('missing exports', () => {
    const manifest: Record<string, unknown> = goodPackage('a');
    delete manifest['exports'];
    ws.manifest('packages/a', manifest);
    expect(check()).toEqual([
      "packages/a (@drefyn/a): exports: missing; point '.' at ./src/index.ts",
    ]);
  });

  it('exports that are not an object of entry points', () => {
    ws.manifest('packages/a', goodPackage('a', { exports: ['./src/index.ts'] }));
    ws.manifest(
      'packages/b',
      goodPackage('b', { exports: { '.': './src/index.ts', import: './src/x.ts' } }),
    );
    ws.manifest('packages/c', goodPackage('c', { exports: {} }));
    expect(check()).toEqual([
      'packages/a (@drefyn/a): exports: must be a string or an object',
      'packages/b (@drefyn/b): exports: mixes subpath keys and condition keys',
      "packages/c (@drefyn/c): exports: has no entry points; point '.' at ./src/index.ts",
    ]);
  });

  it('a wildcard key', () => {
    ws.manifest(
      'packages/a',
      goodPackage('a', { exports: { '.': './src/index.ts', './*': './src/*.ts' } }),
    );
    expect(check()).toEqual([
      'packages/a (@drefyn/a): exports["./*"]: wildcard keys are not allowed; list each entry point',
      'packages/a (@drefyn/a): exports["./*"]: wildcard targets are not allowed',
    ]);
  });

  it('a wildcard target', () => {
    ws.manifest(
      'packages/a',
      goodPackage('a', { exports: { '.': './src/index.ts', './icons': './src/icons/*' } }),
    );
    expect(check()).toEqual([
      'packages/a (@drefyn/a): exports["./icons"]: wildcard targets are not allowed',
    ]);
  });

  it('an export key that names src', () => {
    ws.manifest(
      'packages/a',
      goodPackage('a', {
        exports: { '.': './src/index.ts', './src/internal.ts': './src/internal.ts' },
      }),
    );
    expect(check()).toEqual([
      'packages/a (@drefyn/a): exports["./src/internal.ts"]: keys must not expose src paths',
    ]);
  });

  it('a private target outside src/', () => {
    ws.manifest('packages/a', goodPackage('a', { exports: { '.': './lib/index.ts' } }));
    expect(check()).toEqual([
      'packages/a (@drefyn/a): exports["."]: target \'./lib/index.ts\' must be under ./src/ in a private package',
    ]);
  });

  it('a published target outside dist/', () => {
    ws.manifest('packages/sdk', {
      name: '@drefyn/sdk',
      scripts: SCRIPTS,
      version: '0.1.0',
      type: 'module',
      exports: { '.': './src/index.ts' },
    });
    expect(check()).toEqual([
      'packages/sdk (@drefyn/sdk): exports["."]: target \'./src/index.ts\' must be under ./dist/ in a published package',
    ]);
  });

  it('a target that climbs out of src/ or is not a string', () => {
    ws.manifest(
      'packages/a',
      goodPackage('a', { exports: { '.': './src/../secret.ts', './x': 42 } }),
    );
    expect(check()).toEqual([
      'packages/a (@drefyn/a): exports["."]: target \'./src/../secret.ts\' must be under ./src/ in a private package',
      'packages/a (@drefyn/a): exports["./x"]: target must be a string or a conditions object',
    ]);
  });

  it('type other than module', () => {
    ws.manifest('packages/a', goodPackage('a', { type: 'commonjs' }));
    const untyped: Record<string, unknown> = goodPackage('b');
    delete untyped['type'];
    ws.manifest('packages/b', untyped);
    expect(check()).toEqual([
      "packages/a (@drefyn/a): type: must be 'module', found 'commonjs'",
      "packages/b (@drefyn/b): type: must be 'module', found nothing",
    ]);
  });

  it('a name that does not match the directory', () => {
    ws.manifest('packages/a', goodPackage('b'));
    ws.manifest('apps/web', { ...goodPackage('web'), name: 'web' });
    expect(check()).toEqual([
      "apps/web (web): name: must be '@drefyn/web'",
      "packages/a (@drefyn/b): name: must be '@drefyn/a'",
    ]);
  });

  it('a published package depending on a private one', () => {
    ws.manifest('packages/a', goodPackage('a'));
    ws.manifest('packages/sdk', {
      name: '@drefyn/sdk',
      scripts: SCRIPTS,
      version: '0.1.0',
      type: 'module',
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
      dependencies: { '@drefyn/a': 'workspace:*' },
      peerDependencies: { '@drefyn/a': 'workspace:*' },
    });
    expect(check()).toEqual([
      'packages/sdk (@drefyn/sdk): dependencies["@drefyn/a"]: a published package cannot depend on private @drefyn/a',
      'packages/sdk (@drefyn/sdk): peerDependencies["@drefyn/a"]: a published package cannot depend on private @drefyn/a',
    ]);
  });

  it('any dependency on an app', () => {
    ws.manifest('apps/web', goodPackage('web'));
    ws.manifest(
      'apps/docs',
      goodPackage('docs', { devDependencies: { '@drefyn/web': 'workspace:*' } }),
    );
    ws.manifest('packages/a', goodPackage('a', { dependencies: { '@drefyn/web': 'workspace:*' } }));
    ws.manifest('scripts/tool', {
      name: '@drefyn/tool',
      private: true,
      type: 'module',
      optionalDependencies: { '@drefyn/web': 'workspace:*' },
    });
    expect(check()).toEqual([
      'apps/docs (@drefyn/docs): devDependencies["@drefyn/web"]: apps are never dependencies; move shared code into a package',
      'packages/a (@drefyn/a): dependencies["@drefyn/web"]: apps are never dependencies; move shared code into a package',
      'scripts/tool (@drefyn/tool): optionalDependencies["@drefyn/web"]: apps are never dependencies; move shared code into a package',
    ]);
  });

  it('lint or typecheck scripts that are not exactly the template commands', () => {
    const lint = (detail: string) =>
      `packages/${detail} (@drefyn/${detail}): scripts.lint: must be 'eslint --max-warnings 0 .'; the boundary rules only run through it`;
    const typecheck = (detail: string) =>
      `packages/${detail} (@drefyn/${detail}): scripts.typecheck: must be 'tsc -p tsconfig.json'; the boundary rules only run through it`;
    const cases: [string, Record<string, string>][] = [
      ['a', { lint: 'echo skipped' }],
      ['b', { ...SCRIPTS, lint: 'echo eslint skipped' }],
      ['c', { ...SCRIPTS, lint: `eslint --max-warnings 0 --rule "${NO_EGRESS}: off" .` }],
      ['d', { ...SCRIPTS, lint: 'eslint -c other.config.js .' }],
      ['e', { ...SCRIPTS, lint: 'eslint --no-config-lookup .' }],
      ['f', { ...SCRIPTS, lint: 'eslint --max-warnings 0 . --ignore-pattern src' }],
      ['g', { ...SCRIPTS, typecheck: 'tsc -p other.json' }],
    ];
    for (const [name, scripts] of cases)
      ws.manifest(`packages/${name}`, goodPackage(name, { scripts }));
    expect(check()).toEqual([
      lint('a'),
      typecheck('a'),
      lint('b'),
      lint('c'),
      lint('d'),
      lint('e'),
      lint('f'),
      typecheck('g'),
    ]);
  });

  it('an ESLint config anywhere below the root, in every extension', () => {
    ws.manifest('packages/a', goodPackage('a'));
    ws.write('packages/a/eslint.config.mjs', 'export default [];\n');
    ws.write('packages/a/src/sub/eslint.config.js', 'export default [{}];\n');
    ws.write('packages/a/src/deep/er/eslint.config.cjs', 'module.exports = [];\n');
    ws.write('packages/a/src/build/eslint.config.ts', 'export default [];\n');
    ws.write('packages/a/src/dist/eslint.config.mts', 'export default [];\n');
    ws.write('packages/a/.hidden/eslint.config.cts', 'export default [];\n');
    ws.manifest('scripts/tool', { name: '@drefyn/tool', private: true, type: 'module' });
    ws.write('scripts/tool/eslint.config.js', 'export default [];\n');
    ws.write('shared/eslint.config.js', 'export default [];\n');
    const detail = 'replaces the root config and drops the drefyn rules for that folder';
    expect(check()).toEqual([
      `packages/a (@drefyn/a): .hidden/eslint.config.cts: ${detail}`,
      `packages/a (@drefyn/a): eslint.config.mjs: ${detail}`,
      `packages/a (@drefyn/a): src/build/eslint.config.ts: ${detail}`,
      `packages/a (@drefyn/a): src/deep/er/eslint.config.cjs: ${detail}`,
      `packages/a (@drefyn/a): src/dist/eslint.config.mts: ${detail}`,
      `packages/a (@drefyn/a): src/sub/eslint.config.js: ${detail}`,
      `scripts/tool (@drefyn/tool): eslint.config.js: ${detail}`,
      `root: shared/eslint.config.js: ${detail}`,
    ]);
  });

  it('a pnpm-workspace.yaml anywhere below the root', () => {
    ws.manifest('packages/a', goodPackage('a'));
    ws.write('packages/a/src/pnpm-workspace.yaml', 'minimumReleaseAge: 1\n');
    ws.write('tools/nested/pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
    const detail = 'starts a separate workspace, so the drefyn rules stop seeing the real packages';
    expect(check()).toEqual([
      `packages/a (@drefyn/a): src/pnpm-workspace.yaml: ${detail}`,
      `root: tools/nested/pnpm-workspace.yaml: ${detail}`,
    ]);
  });

  it('leaves the lint rule fixtures and node_modules alone', () => {
    ws.manifest('packages/a', goodPackage('a'));
    ws.write('scripts/lint-rules/test/fixtures/w/pnpm-workspace.yaml', 'packages:\n  - p/*\n');
    ws.write('scripts/lint-rules/test/fixtures/w/eslint.config.js', 'export default [];\n');
    ws.write('packages/a/node_modules/dep/eslint.config.js', 'export default [];\n');
    ws.write('packages/a/node_modules/dep/pnpm-workspace.yaml', 'packages: []\n');
    expect(check()).toEqual([]);
  });

  it('a package.json that is not valid JSON', () => {
    ws.write('packages/a/package.json', '{ "name": ');
    expect(check()).toEqual(['packages/a (no name): package.json: not valid JSON']);
  });
});

describe('manifest checker on paths the rules and the guard cannot see through', () => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: ws.root });
  // Ignored paths only reach the index when someone forces them in, which is the case
  // these tests stand for.
  const forceAdd = (...paths: string[]) => git('add', '--force', '--', ...paths);
  const gitlink = (path: string) => {
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ws.root, encoding: 'utf8' });
    git('update-index', '--add', '--cacheinfo', `160000,${head.trim()},${path}`);
  };
  beforeEach(() => {
    ws.manifest('packages/a', goodPackage('a'));
    ws.manifest('scripts/tool', { name: '@drefyn/tool', private: true, type: 'module' });
    ws.write('scripts/tool/src/secret.ts', 'export const secret = 1;\n');
  });

  const SYMLINK = 'symlinks are not allowed; the rules and the guard see the link, not its target';
  const SUBMODULE = 'submodules are not allowed; nothing inside one is linted';
  const NODE_MODULES =
    'node_modules is never committed; Node resolves bare names into it and nothing lints it';
  const fileType = (ext: string) =>
    `file type ${ext} is not allowed outside scripts/, .github/ and deploy/; Node can load it as code and nothing lints it. ` +
    'To allow a new type, add it to ALLOWED_EXTENSIONS in scripts/lint-rules/src/manifest.ts, which needs security review';

  it('I5: a path segment that starts with a dash, which tools read as an option', () => {
    ws.write('--config=evil.mjs', '');
    ws.write('packages/a/src/-x/index.ts', 'export {};\n');
    git('add', '-A');
    const detail = "starts with '-', which tools read as an option";
    expect(check()).toEqual([
      `packages/a (@drefyn/a): src/-x/index.ts: ${detail}`,
      `root: --config=evil.mjs: ${detail}`,
    ]);
  });

  it('I4: a tracked or new symlink, file or directory, at the root, in packages and in scripts', () => {
    // A directory link lets a package import another package's internals by a path
    // that looks like its own.
    symlinkSync('../../../scripts/tool/src', join(ws.root, 'packages/a/src-link'));
    mkdirSync(join(ws.root, 'packages/a/src'), { recursive: true });
    symlinkSync('../../../scripts/tool/src', join(ws.root, 'packages/a/src/hy'));
    symlinkSync('../../scripts/tool/src/secret.ts', join(ws.root, 'packages/a/file.ts'));
    ws.write('packages/a/src/index.ts', "export * from './hy/secret.ts';\n");
    symlinkSync('scripts/tool/src/secret.ts', join(ws.root, 'linked.ts'));
    symlinkSync('scripts/tool/src', join(ws.root, 'linked-dir'));
    symlinkSync('src/secret.ts', join(ws.root, 'scripts/tool/link.ts'));
    symlinkSync('src', join(ws.root, 'scripts/tool/link-dir'));
    git('add', 'packages/a/src/hy', 'linked.ts', 'scripts/tool/link.ts', 'packages/a/src/index.ts');
    expect(check()).toEqual([
      `packages/a (@drefyn/a): file.ts: ${SYMLINK}`,
      `packages/a (@drefyn/a): src-link: ${SYMLINK}`,
      `packages/a (@drefyn/a): src/hy: ${SYMLINK}`,
      `root: linked-dir: ${SYMLINK}`,
      `root: linked.ts: ${SYMLINK}`,
      `scripts/tool (@drefyn/tool): link-dir: ${SYMLINK}`,
      `scripts/tool (@drefyn/tool): link.ts: ${SYMLINK}`,
    ]);
  });

  it('I4: a submodule at the root, in packages and in scripts, and a nested repository', () => {
    gitlink('packages/a/vendor');
    // An untracked nested repository: git lists it as packages/a/nested/ and nothing in it.
    mkdirSync(join(ws.root, 'packages/a/nested'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: join(ws.root, 'packages/a/nested') });
    ws.write('packages/a/nested/x.ts', 'export {};\n');
    git('update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},sub`);
    git('update-index', '--add', '--cacheinfo', `160000,${'b'.repeat(40)},scripts/tool/sub`);
    expect(check()).toEqual([
      `packages/a (@drefyn/a): nested: ${SUBMODULE}`,
      `packages/a (@drefyn/a): vendor: ${SUBMODULE}`,
      `root: sub: ${SUBMODULE}`,
      `scripts/tool (@drefyn/tool): sub: ${SUBMODULE}`,
    ]);
  });

  it('I3: anything under a node_modules segment, any case, anywhere, fixtures included', () => {
    for (const path of [
      'packages/a/src/node_modules/x',
      'packages/a/src/node_modules/x.ts',
      'scripts/x/node_modules/y.js',
      'common/Node_Modules/x.js',
      'scripts/lint-rules/test/fixtures/w/node_modules/z.js',
    ]) {
      ws.write(path, 'module.exports = 1;\n');
    }
    symlinkSync('../../../../scripts/tool/src', join(ws.root, 'packages/a/src/node_modules/gh'));
    forceAdd(
      'packages/a/src/node_modules',
      'scripts/x/node_modules/y.js',
      'common/Node_Modules/x.js',
      'scripts/lint-rules/test/fixtures/w/node_modules/z.js',
    );
    gitlink('packages/a/src/node_modules/sub');
    expect(check()).toEqual([
      `packages/a (@drefyn/a): src/node_modules/gh: ${NODE_MODULES}`,
      `packages/a (@drefyn/a): src/node_modules/gh: ${SYMLINK}`,
      `packages/a (@drefyn/a): src/node_modules/sub: ${NODE_MODULES}`,
      `packages/a (@drefyn/a): src/node_modules/sub: ${SUBMODULE}`,
      `packages/a (@drefyn/a): src/node_modules/x: ${NODE_MODULES}`,
      `packages/a (@drefyn/a): src/node_modules/x: ${fileType('(no extension)')}`,
      `packages/a (@drefyn/a): src/node_modules/x.ts: ${NODE_MODULES}`,
      `root: common/Node_Modules/x.js: ${NODE_MODULES}`,
      `root: scripts/lint-rules/test/fixtures/w/node_modules/z.js: ${NODE_MODULES}`,
      `root: scripts/x/node_modules/y.js: ${NODE_MODULES}`,
    ]);
  });

  it('I1: a file outside the reviewed set that Node could run but nothing lints', () => {
    for (const name of ['net', 'net.dat', 'LOADER.MJS', 'run.sh', 'x.d.mts.bak', 'x.MJS']) {
      ws.write(`packages/a/src/${name}`, 'module.exports = 1;\n');
    }
    ws.manifest('apps/web', goodPackage('web'));
    ws.write('apps/web/src/.hidden', 'x');
    // lib/net: a root folder file that Node loads as ESM or through require.
    for (const path of [
      'common/net',
      'common/.tls',
      'vendor/net',
      'templates/x/net',
      'foo.yaml',
      'lib/net',
    ]) {
      ws.write(path, 'module.exports = 1;\n');
    }
    ws.write('addon.node', '');
    ws.write('lib/x.wasm', '');
    expect(check()).toEqual([
      `apps/web (@drefyn/web): src/.hidden: ${fileType('(no extension)')}`,
      `packages/a (@drefyn/a): src/LOADER.MJS: ${fileType('.MJS')}`,
      `packages/a (@drefyn/a): src/net: ${fileType('(no extension)')}`,
      `packages/a (@drefyn/a): src/net.dat: ${fileType('.dat')}`,
      `packages/a (@drefyn/a): src/run.sh: ${fileType('.sh')}`,
      `packages/a (@drefyn/a): src/x.MJS: ${fileType('.MJS')}`,
      `packages/a (@drefyn/a): src/x.d.mts.bak: ${fileType('.bak')}`,
      `root: addon.node: ${fileType('.node')}`,
      `root: common/.tls: ${fileType('(no extension)')}`,
      `root: common/net: ${fileType('(no extension)')}`,
      `root: foo.yaml: ${fileType('.yaml')}`,
      `root: lib/net: ${fileType('(no extension)')}`,
      `root: lib/x.wasm: ${fileType('.wasm')}`,
      `root: templates/x/net: ${fileType('(no extension)')}`,
      `root: vendor/net: ${fileType('(no extension)')}`,
    ]);
  });

  it('I1: passes every allowed type, the reviewed set and the listed root files', () => {
    const names = ['a.ts', 'b.tsx', 'c.mts', 'd.cts', 'e.js', 'f.jsx', 'g.mjs', 'h.cjs', 'i.d.ts'];
    names.push('j.json', 'k.css', 'l.md', 'OFL.txt', 'm.svg', 'n.png', 'o.jpg', 'p.webp');
    names.push('q.ico', 'r.woff2', 's.woff', 't.ttf', 'u.otf', 'v.avif', 'w.gif', 'x.jpeg');
    for (const name of names) {
      ws.write(`packages/a/src/${name}`, '\n');
      ws.write(`common/${name}`, '\n');
    }
    ws.write('scripts/tool/run', '#!/bin/sh\n');
    ws.write('.github/workflows/ci.yml', 'on: push\n');
    ws.write('deploy/compose.yaml', 'services: {}\n');
    for (const name of REVIEWED_ROOT_FILES) ws.write(name, '\n');
    ws.write('pnpm-workspace.yaml', 'packages:\n  - packages/*\n  - apps/*\n  - scripts/*\n');
    expect(check()).toEqual([]);
  });

  it('I1: passes a lowercase .sql migration and refuses .SQL', () => {
    ws.write('packages/a/migrations/1_x.sql', 'select 1;\n');
    ws.write('packages/a/migrations/x.SQL', 'select 1;\n');
    expect(check()).toEqual([`packages/a (@drefyn/a): migrations/x.SQL: ${fileType('.SQL')}`]);
  });

  it('I1: judges a path in a merge conflict once, not once per stage', () => {
    const commit = (m: string) =>
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', m);
    ws.write('common/run', 'base\n');
    git('add', '-A');
    commit('base');
    git('checkout', '-q', '-b', 'other');
    ws.write('common/run', 'other\n');
    git('add', '-A');
    commit('other');
    git('checkout', '-q', '-');
    ws.write('common/run', 'main\n');
    git('add', '-A');
    commit('main');
    const merge = spawnSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', 'other'],
      {
        cwd: ws.root,
        encoding: 'utf8',
      },
    );
    expect(merge.status).not.toBe(0);
    const stages = execFileSync('git', ['ls-files', '-s', 'common/run'], {
      cwd: ws.root,
      encoding: 'utf8',
    });
    expect(stages.trim().split('\n')).toHaveLength(3);
    expect(check()).toEqual([`root: common/run: ${fileType('(no extension)')}`]);
  });

  describe('outside git', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('I8: refuses a workspace that is not in a git repository', () => {
      rmSync(join(ws.root, '.git'), { recursive: true, force: true });
      vi.stubEnv('GIT_CEILING_DIRECTORIES', dirname(ws.root));
      expect(() => checkWorkspace(ws.root)).toThrow(/not a git repository/);
    });
  });
});

describe('the reviewed set matches the review gate', () => {
  it('I2: every reviewed prefix and root file asks for security review and has a code owner', () => {
    const rules = JSON.parse(
      readFileSync(join(repoRoot, 'scripts/review-gate/rules.json'), 'utf8'),
    ) as { paths: { security: { prefixes: string[]; names: string[] } } };
    const security = rules.paths.security;
    expect(security.prefixes).toEqual(expect.arrayContaining([...REVIEWED_PREFIXES]));
    expect(security.names).toEqual(expect.arrayContaining([...REVIEWED_ROOT_FILES]));
    const owners = readFileSync(join(repoRoot, '.github/CODEOWNERS'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('#'))
      .map((line) => line.split(/\s+/)[0]);
    for (const path of [...REVIEWED_PREFIXES, ...REVIEWED_ROOT_FILES]) {
      expect(owners, path).toContain(`/${path}`);
    }
  });
});

describe('migrations need security review', () => {
  // Migrations set grants, policies and row level security, so no change there is small.
  it('I2: packages/db/migrations/ asks for security review and has a code owner', () => {
    const rules = JSON.parse(
      readFileSync(join(repoRoot, 'scripts/review-gate/rules.json'), 'utf8'),
    ) as { paths: { security: { prefixes: string[] } } };
    expect(rules.paths.security.prefixes).toContain('packages/db/migrations/');
    const owners = readFileSync(join(repoRoot, '.github/CODEOWNERS'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('#'))
      .map((line) => line.split(/\s+/)[0]);
    expect(owners).toContain('/packages/db/migrations/');
  });
});

describe('manifest checker on inline disables of the boundary rules', () => {
  beforeEach(() => {
    ws.manifest('packages/a', goodPackage('a'));
    ws.manifest('scripts/tool', { name: '@drefyn/tool', private: true, type: 'module' });
  });

  it('fails on every directive form that names either rule', () => {
    ws.write(
      'packages/a/src/index.ts',
      [
        'export const a = 1;',
        `// eslint-disable-next-line ${NO_EGRESS}`,
        `export const b = 2; // eslint-disable-line ${NO_INTERNALS}`,
        `/* eslint-disable no-console, ${NO_INTERNALS} -- just this once */`,
        `/* eslint ${NO_EGRESS}: off */`,
      ].join('\n'),
    );
    expect(check()).toEqual([
      `packages/a (@drefyn/a): src/index.ts:2: inline disable of ${NO_EGRESS} is not allowed`,
      `packages/a (@drefyn/a): src/index.ts:3: inline disable of ${NO_INTERNALS} is not allowed`,
      `packages/a (@drefyn/a): src/index.ts:4: inline disable of ${NO_INTERNALS} is not allowed`,
      `packages/a (@drefyn/a): src/index.ts:5: inline disable of ${NO_EGRESS} is not allowed`,
    ]);
  });

  it('fails on a config comment that spells a rule name with JSON escapes', () => {
    // ESLint decodes the comment as JSON, so these turn the rules off just the same.
    const escapedEgress = NO_EGRESS.replace('-', '\\u002d');
    const escapedInternals = NO_INTERNALS.replace('/', '\\/');
    ws.write(
      'packages/a/src/index.ts',
      [
        `/* eslint "${escapedEgress}": "off" */`,
        `/* eslint "${escapedInternals}": 0, "no-console": "off" */`,
        `/* eslint "\\u0064refyn/no-raw-egress": ["off"] */`,
        'export const a = 1;',
      ].join('\n'),
    );
    expect(check()).toEqual([
      `packages/a (@drefyn/a): src/index.ts:1: inline disable of ${NO_EGRESS} is not allowed`,
      `packages/a (@drefyn/a): src/index.ts:2: inline disable of ${NO_INTERNALS} is not allowed`,
      `packages/a (@drefyn/a): src/index.ts:3: inline disable of ${NO_EGRESS} is not allowed`,
    ]);
  });

  it('checks build/ and out/ folders, which ESLint lints', () => {
    ws.write(
      'packages/a/src/build/raw.ts',
      `// eslint-disable-next-line ${NO_EGRESS}\nfetch('x');\n`,
    );
    ws.write(
      'packages/a/src/out/raw.ts',
      `// eslint-disable-next-line ${NO_EGRESS}\nfetch('x');\n`,
    );
    expect(check()).toEqual([
      `packages/a (@drefyn/a): src/build/raw.ts:1: inline disable of ${NO_EGRESS} is not allowed`,
      `packages/a (@drefyn/a): src/out/raw.ts:1: inline disable of ${NO_EGRESS} is not allowed`,
    ]);
  });

  it('I11: reads directives the way ESLint does: quoted names and long description markers', () => {
    ws.write(
      'packages/a/src/index.ts',
      [
        `// eslint-disable-next-line "${NO_EGRESS}"`,
        `// eslint-disable-next-line '${NO_EGRESS}'`,
        `// eslint-disable-next-line ${NO_EGRESS} --- reviewed`,
        `/* eslint-disable no-console, '${NO_INTERNALS}' ---- because */`,
        `// eslint-disable-line ${NO_EGRESS}\t--\tok`,
        'export const a = 1;',
      ].join('\n'),
    );
    ws.write(
      'packages/a/src/blanket.ts',
      '/* eslint-disable --- reviewed */\nexport const b = 1;\n',
    );
    expect(check()).toEqual([
      'packages/a (@drefyn/a): src/blanket.ts:1: a blanket eslint-disable also turns off the drefyn rules; name the rules instead',
      `packages/a (@drefyn/a): src/index.ts:1: inline disable of ${NO_EGRESS} is not allowed`,
      `packages/a (@drefyn/a): src/index.ts:2: inline disable of ${NO_EGRESS} is not allowed`,
      `packages/a (@drefyn/a): src/index.ts:3: inline disable of ${NO_EGRESS} is not allowed`,
      `packages/a (@drefyn/a): src/index.ts:4: inline disable of ${NO_INTERNALS} is not allowed`,
      `packages/a (@drefyn/a): src/index.ts:5: inline disable of ${NO_EGRESS} is not allowed`,
    ]);
  });

  it('I11: leaves comments ESLint does not read as directives alone', () => {
    ws.write(
      'packages/a/src/index.ts',
      [
        `// see eslint-disable-next-line ${NO_EGRESS} in the docs`,
        `/** eslint-disable ${NO_EGRESS} */`,
        `// eslint-disable-next-line no-console -- not ${NO_EGRESS}`,
        `// eslint-disable-next-line no-console --- mentions ${NO_INTERNALS}`,
        'export const a = 1;',
      ].join('\n'),
    );
    expect(check()).toEqual([]);
  });

  it('fails on a blanket disable, which turns both rules off', () => {
    ws.write('packages/a/src/gen.tsx', '/* eslint-disable */\nexport const A = () => <div />;\n');
    expect(check()).toEqual([
      'packages/a (@drefyn/a): src/gen.tsx:1: a blanket eslint-disable also turns off the drefyn rules; name the rules instead',
    ]);
  });

  it('checks scripts packages and root files too', () => {
    ws.write('scripts/tool/src/cli.ts', `// eslint-disable-next-line ${NO_EGRESS}\nfetch('x');\n`);
    ws.write('setup.mjs', `/* eslint-disable-next-line ${NO_INTERNALS} */\nexport {};\n`);
    expect(check()).toEqual([
      `scripts/tool (@drefyn/tool): src/cli.ts:1: inline disable of ${NO_EGRESS} is not allowed`,
      `root: setup.mjs:1: inline disable of ${NO_INTERNALS} is not allowed`,
    ]);
  });

  it('still finds a directive in a file the parser cannot read', () => {
    ws.write(
      'packages/a/src/broken.ts',
      `export const = ;\n// eslint-disable-next-line ${NO_EGRESS}\n`,
    );
    expect(check()).toEqual([
      `packages/a (@drefyn/a): src/broken.ts:2: inline disable of ${NO_EGRESS} is not allowed`,
    ]);
  });

  it('ignores other rules, strings, prose and ignored paths that are not in the tree', () => {
    ws.write('.gitignore', 'node_modules/\ndist/\n');
    ws.write(
      'packages/a/src/index.ts',
      [
        '// eslint-disable-next-line no-console',
        `export const text = '// eslint-disable-next-line ${NO_EGRESS}';`,
        `export const doc = 'see ${NO_INTERNALS}';`,
      ].join('\n'),
    );
    ws.write('packages/a/README.md', `Never write // eslint-disable-next-line ${NO_EGRESS}.\n`);
    ws.write('packages/a/node_modules/dep/index.js', '/* eslint-disable */\n');
    ws.write('packages/a/dist/index.js', '/* eslint-disable */\n');
    ws.write(
      'scripts/lint-rules/test/fixtures/w/src/x.ts',
      `// eslint-disable-next-line ${NO_EGRESS}\n`,
    );
    expect(check()).toEqual([]);
  });

  it('I11: reads every source file in the tree, dot folders and tracked build output included', () => {
    ws.write('.gitignore', 'node_modules/\ndist/\ncoverage/\n');
    const disable = `// eslint-disable-next-line ${NO_EGRESS}\nfetch('x');\n`;
    ws.write('packages/a/src/.gen/raw.ts', disable);
    ws.write('packages/a/.storybook/main.ts', disable);
    ws.write('.storybook/main.ts', disable);
    ws.write('packages/a/dist/x.js', `/* eslint-disable ${NO_EGRESS} */\n`);
    ws.write('common/coverage/y.ts', '/* eslint-disable */\n');
    ws.write('.cache/x.js', disable);
    execFileSync('git', ['add', '--force', '--', 'packages/a/dist/x.js', 'common/coverage/y.ts'], {
      cwd: ws.root,
    });
    expect(check()).toEqual([
      `root: .cache/x.js:1: inline disable of ${NO_EGRESS} is not allowed`,
      `root: .storybook/main.ts:1: inline disable of ${NO_EGRESS} is not allowed`,
      'root: common/coverage/y.ts:1: a blanket eslint-disable also turns off the drefyn rules; name the rules instead',
      `packages/a (@drefyn/a): .storybook/main.ts:1: inline disable of ${NO_EGRESS} is not allowed`,
      `packages/a (@drefyn/a): dist/x.js:1: inline disable of ${NO_EGRESS} is not allowed`,
      `packages/a (@drefyn/a): src/.gen/raw.ts:1: inline disable of ${NO_EGRESS} is not allowed`,
    ]);
  });
});

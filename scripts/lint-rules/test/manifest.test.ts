import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkWorkspace, formatFinding } from '../src/manifest.ts';
import { goodPackage, repoRoot, SCRIPTS, tempWorkspace, type TempWorkspace } from './helpers.ts';

let ws: TempWorkspace;
beforeEach(() => {
  ws = tempWorkspace();
});
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
    expect(check()).toEqual([
      'packages/a (@drefyn/a): exports: must be a string or an object',
      'packages/b (@drefyn/b): exports: mixes subpath keys and condition keys',
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

  it('lint or typecheck scripts that do not run eslint and tsc', () => {
    ws.manifest('packages/a', goodPackage('a', { scripts: { lint: 'echo skipped' } }));
    expect(check()).toEqual([
      'packages/a (@drefyn/a): scripts.lint: must run eslint; the boundary rules only run through it',
      'packages/a (@drefyn/a): scripts.typecheck: must run tsc; the boundary rules only run through it',
    ]);
  });

  it('a package level ESLint config, which would replace the root one', () => {
    ws.manifest('packages/a', goodPackage('a'));
    ws.write('packages/a/eslint.config.mjs', 'export default [];\n');
    ws.manifest('scripts/tool', { name: '@drefyn/tool', private: true, type: 'module' });
    ws.write('scripts/tool/eslint.config.js', 'export default [];\n');
    expect(check()).toEqual([
      'packages/a (@drefyn/a): eslint.config.mjs: replaces the root config and drops the drefyn rules',
      'scripts/tool (@drefyn/tool): eslint.config.js: replaces the root config and drops the drefyn rules',
    ]);
  });

  it('a package.json that is not valid JSON', () => {
    ws.write('packages/a/package.json', '{ "name": ');
    expect(check()).toEqual(['packages/a (no name): package.json: not valid JSON']);
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

  it('ignores other rules, strings, prose and build output', () => {
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
    ws.write('.cache/x.js', '/* eslint-disable */\n');
    expect(check()).toEqual([]);
  });
});

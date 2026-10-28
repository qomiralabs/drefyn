import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkWorkspace, formatFinding } from '../src/manifest.ts';
import {
  GIT_INIT_HOOK_TIMEOUT_MS,
  goodPackage,
  tempWorkspace,
  type TempWorkspace,
} from './helpers.ts';

let ws: TempWorkspace;
beforeEach(() => {
  ws = tempWorkspace();
}, GIT_INIT_HOOK_TIMEOUT_MS);
afterEach(() => {
  ws.cleanup();
});

const check = () => checkWorkspace(ws.root).findings.map(formatFinding);

// A package with a pure ./pure entry whose file holds the given source.
function purePackage(source: string, extra: Record<string, string> = {}) {
  ws.manifest(
    'packages/a',
    goodPackage('a', {
      exports: {
        '.': './src/index.ts',
        './pure': './src/pure.ts',
        './package.json': './package.json',
      },
      drefyn: { pureEntries: ['./pure'] },
    }),
  );
  ws.write('packages/a/src/index.ts', 'export {};\n');
  ws.write('packages/a/src/pure.ts', source);
  for (const [path, text] of Object.entries(extra)) ws.write(`packages/a/src/${path}`, text);
}

const where = 'packages/a (@drefyn/a)';

describe('pure entries', () => {
  it('pass when the graph has only relative imports and type imports of packages', () => {
    purePackage(
      "import type { Tier } from '@drefyn/entitlements';\nimport { x } from './inner.ts';\nexport type { Tier };\nexport { x };\nexport type { Y } from '@drefyn/other';\n",
      { 'inner.ts': 'export const x = 1;\n' },
    );
    expect(check()).toEqual([]);
  });

  it('refuse a Node built in, by prefix or bare name, even as a type import', () => {
    purePackage(
      "import { readFileSync } from 'node:fs';\nimport type { Hash } from 'crypto';\nexport { readFileSync };\nexport type { Hash };\n",
    );
    expect(check()).toEqual([
      `${where}: src/pure.ts:1: pure entry './pure' imports Node built in 'node:fs'`,
      `${where}: src/pure.ts:2: pure entry './pure' imports Node built in 'crypto'`,
    ]);
  });

  it('refuse a runtime import of a package, including an inline type import that still loads it', () => {
    purePackage(
      "import { z } from 'zod';\nimport { type T } from '@drefyn/other';\nexport * from 'kleur';\nexport { z };\nexport type { T };\n",
    );
    expect(check()).toEqual([
      `${where}: src/pure.ts:1: pure entry './pure' loads package 'zod' at runtime; only 'import type' is allowed`,
      `${where}: src/pure.ts:2: pure entry './pure' loads package '@drefyn/other' at runtime; only 'import type' is allowed`,
      `${where}: src/pure.ts:3: pure entry './pure' loads package 'kleur' at runtime; only 'import type' is allowed`,
    ]);
  });

  it('follow relative imports and refuse what the inner file loads', () => {
    purePackage("export { y } from './inner.ts';\n", {
      'inner.ts': "import { hostname } from 'node:os';\nexport const y = hostname;\n",
    });
    expect(check()).toEqual([
      `${where}: src/inner.ts:1: pure entry './pure' imports Node built in 'node:os'`,
    ]);
  });

  it('refuse dynamic imports, require and computed specifiers', () => {
    purePackage(
      "export const a = () => import('./inner.ts');\nexport const b = () => require('node:fs');\nconst name = 'x';\nexport const c = () => import(name);\n",
      { 'inner.ts': 'export {};\n' },
    );
    expect(check()).toEqual([
      `${where}: src/pure.ts:1: pure entry './pure' loads './inner.ts' dynamically`,
      `${where}: src/pure.ts:2: pure entry './pure' imports Node built in 'node:fs'`,
      `${where}: src/pure.ts:4: pure entry './pure' loads a computed specifier`,
    ]);
  });

  it('refuse a relative import that leaves the package or does not exist', () => {
    purePackage("import '../../b/src/index.ts';\nimport './missing.ts';\n");
    ws.manifest('packages/b', goodPackage('b'));
    ws.write('packages/b/src/index.ts', 'export {};\n');
    expect(check()).toEqual([
      `${where}: src/pure.ts:1: pure entry './pure' imports '../../b/src/index.ts' from outside the package`,
      `${where}: src/pure.ts:2: pure entry './pure' imports './missing.ts', which does not exist`,
    ]);
  });

  it('refuse an entry that is not in the exports map, and a list that is not strings', () => {
    ws.manifest('packages/a', goodPackage('a', { drefyn: { pureEntries: ['./nope', 3] } }));
    ws.write('packages/a/src/index.ts', 'export {};\n');
    expect(check()).toEqual([
      `${where}: drefyn.pureEntries: './nope' is not a string entry in exports`,
      `${where}: drefyn.pureEntries: must be a list of export keys`,
    ]);
  });
});

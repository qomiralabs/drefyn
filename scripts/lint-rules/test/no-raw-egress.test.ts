import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fixture, makeEslint, reports, tempWorkspace, type TempWorkspace } from './helpers.ts';

const RULE = 'drefyn/no-raw-egress';
const root = fixture('egress');
const raw = readFileSync(join(root, 'packages/web/src/raw.ts'), 'utf8');
const RAW_FETCH = "export const f = fetch('x');";

const allow = [
  { path: 'scripts/tool/src/github.ts', reason: 'fixed GitHub API host' },
  { path: 'scripts/tool/vendor/', reason: 'a directory entry' },
];
const eslint = makeEslint(root, { [RULE]: ['error', { allow }] });

const message = (api: string, pkg: string) =>
  `Outbound network calls go through @drefyn/egress (guardedFetch). Raw '${api}' is not allowed in ${pkg}.`;

// Line and API for each report in raw.ts, in source order.
const expected: [number, string][] = [
  [2, 'node:http'],
  [3, 'https'],
  [4, 'node:http2'],
  [5, 'net'],
  [6, 'node:tls'],
  [7, 'dgram'],
  [8, 'node:dns'],
  [9, 'dns/promises'],
  [10, 'undici'],
  [11, 'undici/lib/dispatcher/agent.js'],
  [12, 'node:https'],
  [13, 'node:net'],
  [14, 'http'],
  [15, 'fetch'],
  [16, 'fetch'],
  [17, 'fetch'],
  [18, 'WebSocket'],
  [19, 'fetch'],
  [21, 'node:net'], // import x = require(); the type only form on line 22 is fine
  [24, 'tls'],
  [25, 'node:dgram'],
  [26, 'dns'],
  [27, 'fetch'], // destructured from globalThis
  [28, 'fetch'], // globalThis.globalThis
  [29, 'node:http'], // process.getBuiltinModule
  [31, 'node:https'], // createRequire(...)(...)
  [33, 'net'], // a require made by createRequire
  [34, '_http_client'],
  [35, 'node:tls'], // module.require
  [38, 'WebSocket'], // destructuring assignment
  [39, 'fetch'], // parameter default
  [43, 'fetch'], // nested pattern
  [46, '_http_agent'],
  [47, 'node:_tls_wrap'],
  [48, '_stream_wrap'],
];

async function lintAs(path: string, code = raw) {
  return reports(await eslint.lintText(code, { filePath: join(root, path) }));
}

describe('no-raw-egress outside packages/egress', () => {
  it('reports every banned module in both forms and global fetch and WebSocket', async () => {
    const found = await lintAs('packages/web/src/raw.ts');
    expect(found).toEqual(
      expected.map(([line, api]) => ({ line, ruleId: RULE, message: message(api, '@drefyn/web') })),
    );
  });

  it('names the owning package, or the root package for root files', async () => {
    const inTool = await lintAs('scripts/tool/src/other.ts', "export const f = fetch('x');");
    expect(inTool.map((r) => r.message)).toEqual([message('fetch', '@drefyn/tool')]);
    const atRoot = await lintAs('setup.ts', "import net from 'node:net';\nexport { net };");
    expect(atRoot.map((r) => r.message)).toEqual([message('node:net', 'egress-fixture')]);
  });

  it('reports a configured global in plain JavaScript', async () => {
    const found = await lintAs('packages/web/src/legacy.js', "export const r = fetch('x');");
    expect(found.map((r) => r.message)).toEqual([message('fetch', '@drefyn/web')]);
  });

  it('leaves type only imports, local bindings and property names alone', async () => {
    expect(reports(await eslint.lintFiles(['packages/web/src/good.ts']))).toEqual([]);
  });
});

describe('no-raw-egress with ambient declarations', () => {
  // declare emits no code, so the name still means the global at run time.
  it.each([
    ['declare const fetch: (url: string) => unknown;\nexport const a = fetch("x");', 'fetch'],
    ['declare function fetch(url: string): unknown;\nexport const a = fetch("x");', 'fetch'],
    [
      'declare let WebSocket: new (url: string) => object;\nexport const s = WebSocket;',
      'WebSocket',
    ],
    [
      'declare const globalThis: { fetch(url: string): unknown };\nexport const a = globalThis.fetch("x");',
      'fetch',
    ],
    [
      'declare const globalThis: { fetch(url: string): unknown };\nexport const { fetch: f } = globalThis;',
      'fetch',
    ],
    ['declare global {\n  var WebSocket: unknown;\n}\nexport const s = WebSocket;', 'WebSocket'],
  ])('reports through %j', async (code, api) => {
    const found = await lintAs('packages/web/src/ambient.ts', code);
    expect(found.map((r) => r.message)).toEqual([message(api, '@drefyn/web')]);
  });

  it('still treats a real local binding as a local', async () => {
    const code = [
      'const fetch = (url: string) => url;',
      'const globalThis = { fetch };',
      'export const a = [fetch("x"), globalThis.fetch("x")];',
      'export const { fetch: f } = globalThis;',
    ].join('\n');
    expect(await lintAs('packages/web/src/local.ts', code)).toEqual([]);
  });

  it('leaves look alike calls with other names or computed arguments alone', async () => {
    const code = [
      "import { createRequire } from 'node:module';",
      'const name = String(Date.now());',
      'export const a = createRequire(import.meta.url)(name);',
      "export const b = process.getBuiltinModule('node:path');",
      "export const c = createRequire(import.meta.url)('node:path');",
      "export const d = module.require('node:fs');",
      'export const e = ({ fetch: 1 }).fetch;',
      'export const { other } = globalThis;',
      "export const { ['fetch']: g } = { fetch: 1 };",
      'export const { [name]: h } = globalThis;',
    ].join('\n');
    expect(await lintAs('packages/web/src/lookalike.ts', code)).toEqual([]);
  });
});

describe('no-raw-egress with type only bindings', () => {
  // TypeScript erases these, so at run time the name is still the global.
  it.each([
    ["type global = never;\nexport const r = global.fetch('https://x');", 'fetch'],
    ["export type self = never;\nexport const r = self.fetch('x');", 'fetch'],
    ["import type { fetch } from './types.ts';\nexport const r = fetch('https://x');", 'fetch'],
    [
      "import { type WebSocket } from './types.ts';\nexport const r = new WebSocket('wss://x');",
      'WebSocket',
    ],
    ["interface globalThis { a: 1 }\nexport const r = globalThis.fetch('x');", 'fetch'],
  ])('I9: reports through %j', async (code, api) => {
    const found = await lintAs('packages/web/src/typeonly.ts', code);
    expect(found.map((r) => r.message)).toEqual([message(api, '@drefyn/web')]);
  });

  it('I9: still treats a value import as a local', async () => {
    const code = [
      "import { fetch, type Other } from './client.ts';",
      "import self from './self.ts';",
      "export const r: Other = [fetch('x'), self.fetch('x')];",
    ].join('\n');
    expect(await lintAs('packages/web/src/valueimport.ts', code)).toEqual([]);
  });
});

describe('no-raw-egress through TypeScript wrappers, aliases and templates', () => {
  it.each([
    ['(globalThis as any).fetch("x");', 'fetch'],
    ['globalThis!.fetch("x");', 'fetch'],
    ['(<typeof globalThis>globalThis).fetch("x");', 'fetch'],
    ['(globalThis satisfies object).WebSocket;', 'WebSocket'],
    ['((globalThis as any) as typeof globalThis).globalThis.fetch("x");', 'fetch'],
    ['const { fetch: f } = globalThis as any;\nf("x");', 'fetch'],
    [
      "import { createRequire as cr } from 'node:module';\ncr(import.meta.url)('node:net');",
      'node:net',
    ],
    [
      "import { createRequire as cr } from 'module';\nconst r = cr(import.meta.url);\nr('http');",
      'http',
    ],
    ['process.getBuiltinModule(`node:http`);', 'node:http'],
    [
      "import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)(`node:net`);",
      'node:net',
    ],
    ["process.getBuiltinModule('node:quic');", 'node:quic'],
    ["import 'quic';", 'quic'],
  ])('reports %j', async (code, api) => {
    const found = await lintAs('packages/web/src/wrapped.ts', code);
    expect(found.map((r) => r.message)).toEqual([message(api, '@drefyn/web')]);
  });

  it('leaves an unrelated aliased import alone', async () => {
    const code = "import { builtinModules as cr } from 'node:module';\nexport const n = cr.length;";
    expect(await lintAs('packages/web/src/alias.ts', code)).toEqual([]);
  });
});

describe('no-raw-egress on require style loads of files that are not source', () => {
  let ws: TempWorkspace | undefined;
  afterEach(() => {
    ws?.cleanup();
    ws = undefined;
  });
  const opaque = (spec: string, file: string, advice = true) =>
    `'${spec}' resolves to ${file}, which is not source; Node would run it as code.` +
    (advice ? ' Use a source extension or .json.' : '');
  const lintIn = async (code: string) => {
    const root = ws?.root ?? '';
    const local = makeEslint(root, { [RULE]: 'error' });
    const found = reports(
      await local.lintText(code, { filePath: join(root, 'packages/web/src/load.ts') }),
    );
    return found.map((r) => [r.line, r.message]);
  };
  const setup = () => {
    ws = tempWorkspace();
    ws.manifest('packages/web', { name: '@drefyn/web', private: true, type: 'module' });
    for (const file of ['net.txt', 'x.css', 'net', '.tls', 'blob.dat', 'addon.node']) {
      ws.write(`packages/web/src/${file}`, 'module.exports = 1;\n');
    }
    ws.write('packages/web/src/lib.v2.js', 'module.exports = 1;\n');
    // A folder whose package.json main points at a text file.
    ws.write('packages/web/src/lib/package.json', '{ "main": "net.txt" }\n');
    ws.write('packages/web/src/lib/net.txt', 'module.exports = 1;\n');
    // An extensionless file in a root folder outside every package.
    ws.write('vendor/net', 'module.exports = 1;\n');
    ws.write('packages/web/src/data.json', '{}\n');
    ws.write('packages/index.js', 'module.exports = 1;\n');
    ws.write('packages/web/src/other.js', 'module.exports = 1;\n');
  };

  it('I10: reports the file Node resolves when it is not source or JSON', async () => {
    setup();
    const code = [
      "import { createRequire } from 'node:module';",
      'const load = createRequire(import.meta.url);',
      "export const a = load('./net.txt');",
      "export const b = createRequire(import.meta.url)('./x.css');",
      "export const c = require('./net');",
      "export const d = module.require('./.tls');",
      "export const e = load('./blob.dat');",
      "export const f = load('./addon.node');",
      "export const g = load('./lib');",
      "export const h = load('../../../vendor/net');",
    ].join('\n');
    expect(await lintIn(code)).toEqual([
      [3, opaque('./net.txt', 'packages/web/src/net.txt')],
      [4, opaque('./x.css', 'packages/web/src/x.css')],
      [5, opaque('./net', 'packages/web/src/net')],
      [6, opaque('./.tls', 'packages/web/src/.tls')],
      [7, opaque('./blob.dat', 'packages/web/src/blob.dat')],
      [8, opaque('./addon.node', 'packages/web/src/addon.node', false)],
      [9, opaque('./lib', 'packages/web/src/lib/net.txt')],
      [10, opaque('../../../vendor/net', 'vendor/net')],
    ]);
  });

  it('I10: leaves source, JSON, directories, missing files and ESM imports alone', async () => {
    setup();
    const code = [
      "import { createRequire } from 'node:module';",
      "import './x.css';",
      'const load = createRequire(import.meta.url);',
      "export const a = load('./lib.v2');",
      "export const b = load('../..');",
      "export const c = require('./data.json');",
      "export const d = require('./other');",
      "export const e = require('./missing.txt');",
      "export const f = require('zod/package.json');",
      "export const g = () => import('./x.css');",
    ].join('\n');
    expect(await lintIn(code)).toEqual([]);
  });
});

describe('no-raw-egress exemptions', () => {
  it('allows the same code inside packages/egress', async () => {
    expect(await lintAs('packages/egress/src/raw.ts')).toEqual([]);
  });

  it('allows an allow listed file and anything under an allow listed directory', async () => {
    expect(await lintAs('scripts/tool/src/github.ts')).toEqual([]);
    expect(await lintAs('scripts/tool/vendor/client/http.ts')).toEqual([]);
  });

  it('does not treat a lookalike path as packages/egress or as an allowed file', async () => {
    expect(
      await lintAs('packages/egress-old/src/raw.ts', "export const f = fetch('x');"),
    ).toHaveLength(1);
    expect(
      await lintAs('scripts/tool/src/github.ts.bak.ts', "export const f = fetch('x');"),
    ).toHaveLength(1);
    expect(await lintAs('scripts/tool/vendored.ts', "export const f = fetch('x');")).toHaveLength(
      1,
    );
  });
});

describe('no-raw-egress exemption is decided by the owning package', () => {
  let ws: TempWorkspace | undefined;
  afterEach(() => {
    ws?.cleanup();
    ws = undefined;
  });
  const lintIn = async (path: string) => {
    const root = ws?.root ?? '';
    const local = makeEslint(root, { [RULE]: 'error' });
    return reports(await local.lintText(RAW_FETCH, { filePath: join(root, path) }));
  };

  it('exempts packages/egress only when it is the @drefyn/egress package', async () => {
    ws = tempWorkspace();
    ws.manifest('packages/egress', { name: '@drefyn/egress', private: true, type: 'module' });
    expect(await lintIn('packages/egress/src/raw.ts')).toEqual([]);
  });

  it('does not exempt a packages/egress folder with no manifest or another name', async () => {
    ws = tempWorkspace();
    expect((await lintIn('packages/egress/src/raw.ts')).map((r) => r.message)).toEqual([
      message('fetch', 'temp-root'),
    ]);
    ws.cleanup();
    ws = tempWorkspace();
    ws.manifest('packages/egress', { name: '@drefyn/other', private: true, type: 'module' });
    expect((await lintIn('packages/egress/src/raw.ts')).map((r) => r.message)).toEqual([
      message('fetch', '@drefyn/other'),
    ]);
  });

  it('fails loudly when a nested pnpm-workspace.yaml lists no packages', async () => {
    ws = tempWorkspace();
    ws.manifest('packages/web', { name: '@drefyn/web', private: true, type: 'module' });
    ws.write('packages/web/src/pnpm-workspace.yaml', 'minimumReleaseAge: 1\n');
    await expect(lintIn('packages/web/src/packages/egress/a.ts')).rejects.toThrow(
      /no packages list/,
    );
  });
});

describe('no-raw-egress allow list validation', () => {
  const load = (options: unknown) =>
    makeEslint(root, { [RULE]: ['error', options] }).lintText('export {};', {
      filePath: join(root, 'packages/web/src/x.ts'),
    });

  it('rejects an entry without a reason when the config loads', async () => {
    await expect(load({ allow: [{ path: 'scripts/tool/src/github.ts' }] })).rejects.toThrow(
      /Key "drefyn\/no-raw-egress":\s+Value .* should have required property 'reason'/,
    );
  });

  it('rejects a blank reason, an absolute or escaping path and unknown keys', async () => {
    const bad = [
      { allow: [{ path: 'scripts/tool/src/github.ts', reason: '   ' }] },
      { allow: [{ path: '/etc/passwd', reason: 'absolute' }] },
      { allow: [{ path: 'scripts/../../outside.ts', reason: 'escapes the root' }] },
      { allow: [{ path: 'scripts/tool/src/github.ts', reason: 'ok', note: 'extra' }] },
      { allowed: [] },
    ];
    for (const options of bad) {
      await expect(load(options), JSON.stringify(options)).rejects.toThrow(
        /Key "drefyn\/no-raw-egress"/,
      );
    }
  });

  it('accepts no options and an empty allow list', async () => {
    const none = makeEslint(root, { [RULE]: 'error' });
    const found = reports(
      await none.lintText("export const f = fetch('x');", {
        filePath: join(root, 'scripts/tool/src/github.ts'),
      }),
    );
    expect(found.map((r) => r.message)).toEqual([message('fetch', '@drefyn/tool')]);
    await expect(load({ allow: [] })).resolves.toBeDefined();
  });
});

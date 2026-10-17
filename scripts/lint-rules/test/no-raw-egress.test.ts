import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixture, makeEslint, reports } from './helpers.ts';

const RULE = 'drefyn/no-raw-egress';
const root = fixture('egress');
const raw = readFileSync(join(root, 'packages/web/src/raw.ts'), 'utf8');

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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { egressAllowList, type EgressAllowEntry } from '../src/index.ts';
import { makeEslint, repoRoot, reports } from './helpers.ts';

// The real entries against the real files they cover, so an entry cannot outlive or
// outgrow its file unseen.

const RULE = 'drefyn/no-raw-egress';
const OAUTH_FETCH = 'packages/auth/src/oauth/fetch.ts';
const source = readFileSync(join(repoRoot, OAUTH_FETCH), 'utf8');

async function lint(allow: readonly EgressAllowEntry[], code = source) {
  const eslint = makeEslint(repoRoot, { [RULE]: ['error', { allow }] });
  return reports(await eslint.lintText(code, { filePath: join(repoRoot, OAUTH_FETCH) }));
}

describe('the OAuth fetch entry', () => {
  it('allows only a direct call of the global fetch, with a reason', () => {
    const entry = egressAllowList.find((e) => e.path === OAUTH_FETCH);
    expect(entry).toMatchObject({ only: [{ global: 'fetch' }] });
    expect(entry?.reason).toMatch(/\S/);
  });

  it('lints the file clean with the shared list', async () => {
    expect(await lint(egressAllowList)).toEqual([]);
  });

  it('is required: without it the file is reported', async () => {
    const without = egressAllowList.filter((e) => e.path !== OAUTH_FETCH);
    const found = await lint(without);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((r) => r.ruleId === RULE && r.message.includes("'fetch'"))).toBe(true);
  });

  it.each([
    ['globalThis.fetch', 'export const second = globalThis.fetch;'],
    ['fetch passed as a value', 'export const second = [fetch].length;'],
    ['an import of node:https', "export * as second from 'node:https';"],
  ])('still reports a second form in the same file: %s', async (_name, extra) => {
    const lines = source.split('\n').length;
    const found = await lint(egressAllowList, `${source}\n${extra}\n`);
    expect(found.map((r) => r.line)).toEqual([lines + 1]);
  });
});

// The dashboard's inbound server and the echo server its tests run the wrapper on. Both may
// take createServer from node:http and nothing else.
describe.each(['apps/dashboard/server.ts', 'apps/dashboard/test/integration/support/echo.ts'])(
  'the inbound server entry for %s',
  (path) => {
    const code = readFileSync(join(repoRoot, path), 'utf8');
    const lintFile = async (allow: readonly EgressAllowEntry[], text = code) => {
      const eslint = makeEslint(repoRoot, { [RULE]: ['error', { allow }] });
      return reports(await eslint.lintText(text, { filePath: join(repoRoot, path) }));
    };

    it('allows only the named createServer import from node:http, with a reason', () => {
      const entry = egressAllowList.find((e) => e.path === path);
      expect(entry).toMatchObject({ only: [{ module: 'node:http', imports: ['createServer'] }] });
      expect(entry?.reason).toMatch(/never opens/);
    });

    it('lints the file clean with the shared list', async () => {
      expect(await lintFile(egressAllowList)).toEqual([]);
    });

    it('is required: without it the file is reported', async () => {
      const found = await lintFile(egressAllowList.filter((e) => e.path !== path));
      expect(found.length).toBeGreaterThan(0);
      expect(found.every((r) => r.ruleId === RULE)).toBe(true);
    });

    it.each([
      ['a default import', "import http from 'node:http';\nexport const x = http;"],
      ['a namespace import', "import * as http from 'node:http';\nexport const x = http;"],
      ['another named import', "import { request } from 'node:http';\nexport const x = request;"],
      ['require', "export const x = require('node:http');"],
      ['a dynamic import', "export const x = import('node:http');"],
      ['a fetch call', "export const x = fetch('https://example.com');"],
    ])('still reports %s in the same file', async (_name, extra) => {
      const lines = code.split('\n').length;
      const found = await lintFile(egressAllowList, `${code}\n${extra}\n`);
      expect(found.length).toBeGreaterThan(0);
      expect(found.every((r) => r.line >= lines + 1)).toBe(true);
    });
  },
);

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

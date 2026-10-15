import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';
import { checkLicenses, satisfies, type Policy } from '../src/policy.ts';

const allow = new Set(['MIT', 'Apache-2.0', 'ISC']);

describe('satisfies', () => {
  it.each([
    ['MIT', true],
    ['GPL-3.0', false],
    ['(MIT OR GPL-3.0)', true],
    ['GPL-3.0 OR MIT', true],
    ['MIT AND ISC', true],
    ['MIT AND GPL-3.0', false],
    ['(MIT AND ISC) OR GPL-3.0', true],
    ['GPL-3.0 OR (MIT AND AGPL-3.0)', false],
    ['MIT AND (ISC OR GPL-3.0)', true],
    ['Apache-2.0 WITH LLVM-exception', false],
    ['', false],
    ['Unknown', false],
    ['UNLICENSED', false],
    ['MIT*', false],
    ['(MIT', false],
    ['MIT OR', false],
  ])('%j -> %s', (expression, expected) => {
    expect(satisfies(expression, allow)).toBe(expected);
  });
});

const policy: Policy = {
  allow: ['MIT', 'ISC'],
  exceptions: { 'odd-lib': 'reviewed', 'native-*': 'platform builds of native' },
};

describe('checkLicenses', () => {
  it('passes when every package is allowed or excepted', () => {
    const result = checkLicenses(
      {
        MIT: [{ name: 'a', versions: ['1.0.0'], license: 'MIT' }],
        'MPL-2.0': [
          { name: 'odd-lib', versions: ['2.0.0'], license: 'MPL-2.0' },
          { name: 'native-linux-x64', versions: ['2.0.0'], license: 'MPL-2.0' },
        ],
      },
      policy,
    );
    expect(result).toEqual({
      violations: [],
      checked: 3,
      excepted: ['native-linux-x64', 'odd-lib'],
    });
  });

  it('lists violations with name, versions and license', () => {
    const result = checkLicenses(
      {
        'GPL-3.0': [{ name: 'copyleft', versions: ['1.0.0', '1.1.0'], license: 'GPL-3.0' }],
        MIT: [{ name: 'fine', versions: ['1.0.0'], license: 'MIT' }],
      },
      policy,
    );
    expect(result.violations).toEqual([
      { name: 'copyleft', versions: ['1.0.0', '1.1.0'], license: 'GPL-3.0' },
    ]);
  });

  it('does not let a prefix exception match an unrelated name', () => {
    const result = checkLicenses(
      { 'GPL-3.0': [{ name: 'nativeish', versions: ['1'], license: 'GPL-3.0' }] },
      policy,
    );
    expect(result.violations).toHaveLength(1);
  });

  it('falls back to the group key when an entry has no license field', () => {
    const result = checkLicenses({ ISC: [{ name: 'x', versions: ['1'] }] }, policy);
    expect(result.violations).toEqual([]);
  });

  it('rejects a report that is not grouped lists', () => {
    expect(() => checkLicenses({ MIT: 'nope' } as never, policy)).toThrow(/report/);
  });
});

describe('license-policy cli', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'license-policy-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(report: unknown, extra: string[] = []) {
    const input = join(dir, 'report.json');
    const policyFile = join(dir, 'policy.json');
    writeFileSync(input, JSON.stringify(report));
    writeFileSync(policyFile, JSON.stringify(policy));
    let out = '';
    let err = '';
    const code = main(['--input', input, '--policy', policyFile, ...extra], {
      out: (s) => (out += s),
      err: (s) => (err += s),
    });
    return { code, out, err };
  }

  it('exits 0 on a clean report', () => {
    const res = run({ MIT: [{ name: 'a', versions: ['1'], license: 'MIT' }] });
    expect(res.code).toBe(0);
    expect(res.out).toContain('licenses: 1 packages checked, 0 by exception');
  });

  it('exits 1 and names each violation', () => {
    const res = run({
      'GPL-3.0': [{ name: 'bad', versions: ['1.2.3'], license: 'GPL-3.0' }],
    });
    expect(res.code).toBe(1);
    expect(res.err).toContain('bad@1.2.3: GPL-3.0 is not allowed');
  });

  it('exits 2 on unreadable input', () => {
    let err = '';
    const code = main(['--input', join(dir, 'missing.json')], {
      out: () => undefined,
      err: (s) => (err += s),
    });
    expect(code).toBe(2);
    expect(err).toContain('licenses: error');
  });

  it('exits 2 without --input', () => {
    const code = main([], { out: () => undefined, err: () => undefined });
    expect(code).toBe(2);
  });

  it('exits 2 on a policy with the wrong shape', () => {
    const input = join(dir, 'report.json');
    const policyFile = join(dir, 'policy.json');
    writeFileSync(input, '{}');
    writeFileSync(policyFile, '{"allow": "MIT"}');
    let err = '';
    const code = main(['--input', input, '--policy', policyFile], {
      out: () => undefined,
      err: (s) => (err += s),
    });
    expect(code).toBe(2);
    expect(err).toContain('policy');
  });

  it('uses the policy file next to the package by default', () => {
    const input = join(dir, 'report.json');
    writeFileSync(input, JSON.stringify({ MIT: [{ name: 'a', versions: ['1'], license: 'MIT' }] }));
    const code = main(['--input', input], { out: () => undefined, err: () => undefined });
    expect(code).toBe(0);
  });
});

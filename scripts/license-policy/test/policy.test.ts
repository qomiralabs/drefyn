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
  exceptions: [
    { name: 'odd-lib', license: 'MPL-2.0', reason: 'reviewed' },
    {
      pattern: '^native-(linux|darwin)-(x64|arm64)$',
      license: 'MPL-2.0',
      reason: 'platform builds',
    },
  ],
  forbidden: [],
};

const mpl = (name: string, license = 'MPL-2.0') => ({ name, versions: ['2.0.0'], license });

describe('checkLicenses', () => {
  it('passes when every package is allowed or excepted under its expected license', () => {
    const result = checkLicenses(
      {
        MIT: [{ name: 'a', versions: ['1.0.0'], license: 'MIT' }],
        'MPL-2.0': [mpl('odd-lib'), mpl('native-linux-x64')],
      },
      policy,
    );
    expect(result).toEqual({
      violations: [],
      unusedExceptions: [],
      checked: 3,
      excepted: ['native-linux-x64', 'odd-lib'],
    });
  });

  it('lists violations with name, versions and license', () => {
    const result = checkLicenses(
      {
        'GPL-3.0': [{ name: 'copyleft', versions: ['1.0.0', '1.1.0'], license: 'GPL-3.0' }],
        'MPL-2.0': [mpl('odd-lib'), mpl('native-linux-x64')],
      },
      policy,
    );
    expect(result.violations).toEqual([
      { name: 'copyleft', versions: ['1.0.0', '1.1.0'], license: 'GPL-3.0' },
    ]);
  });

  it('does not except a named package when its license changed', () => {
    const result = checkLicenses(
      { 'GPL-3.0': [mpl('odd-lib', 'GPL-3.0')], 'MPL-2.0': [mpl('native-linux-x64')] },
      policy,
    );
    expect(result.violations).toEqual([
      { name: 'odd-lib', versions: ['2.0.0'], license: 'GPL-3.0', expected: 'MPL-2.0' },
    ]);
    expect(result.unusedExceptions).toEqual([]);
  });

  it.each(['native-evil', 'native-linux-x64-extra', 'xnative-linux-x64', 'native-linux'])(
    'does not let the platform pattern match %s',
    (name) => {
      const result = checkLicenses({ 'MPL-2.0': [mpl('odd-lib'), mpl(name)] }, policy);
      expect(result.violations.map((v) => v.name)).toEqual([name]);
    },
  );

  it('reports exceptions that match no package', () => {
    const result = checkLicenses({ MIT: [{ name: 'a', versions: ['1'], license: 'MIT' }] }, policy);
    expect(result.violations).toEqual([]);
    expect(result.unusedExceptions).toEqual(['odd-lib', '^native-(linux|darwin)-(x64|arm64)$']);
  });

  it('falls back to the group key when an entry has no license field', () => {
    const result = checkLicenses(
      {
        ISC: [{ name: 'x', versions: ['1'] }],
        'MPL-2.0': [mpl('odd-lib'), mpl('native-darwin-arm64')],
      },
      policy,
    );
    expect(result.violations).toEqual([]);
  });

  it('rejects a report that is not grouped lists', () => {
    expect(() => checkLicenses({ MIT: 'nope' } as never, policy)).toThrow(/report/);
  });

  it('rejects a report with no packages, which means the listing broke', () => {
    expect(() => checkLicenses({}, policy)).toThrow(/no packages/);
    expect(() => checkLicenses({ MIT: [] }, policy)).toThrow(/no packages/);
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

  function run(report: unknown, policyValue: unknown = policy) {
    const input = join(dir, 'report.json');
    const policyFile = join(dir, 'policy.json');
    writeFileSync(input, JSON.stringify(report));
    writeFileSync(policyFile, JSON.stringify(policyValue));
    let out = '';
    let err = '';
    const code = main(['--input', input, '--policy', policyFile], {
      out: (s) => (out += s),
      err: (s) => (err += s),
    });
    return { code, out, err };
  }

  const excepted = { 'MPL-2.0': [mpl('odd-lib'), mpl('native-linux-x64')] };

  it('exits 0 on a clean report', () => {
    const res = run({ MIT: [{ name: 'a', versions: ['1'], license: 'MIT' }], ...excepted });
    expect(res.code).toBe(0);
    expect(res.out).toContain('licenses: 3 packages checked, 2 by exception');
  });

  it('exits 1 and names each violation', () => {
    const res = run({
      'GPL-3.0': [{ name: 'bad', versions: ['1.2.3'], license: 'GPL-3.0' }],
      ...excepted,
    });
    expect(res.code).toBe(1);
    expect(res.err).toContain('bad@1.2.3: GPL-3.0 is not allowed');
  });

  it('says which license an exception expected', () => {
    const res = run({
      'GPL-3.0': [mpl('odd-lib', 'GPL-3.0')],
      'MPL-2.0': [mpl('native-linux-x64')],
    });
    expect(res.code).toBe(1);
    expect(res.err).toContain(
      'odd-lib@2.0.0: GPL-3.0 is not allowed (the exception covers MPL-2.0 only)',
    );
  });

  it('exits 1 on an unused exception', () => {
    const res = run({ MIT: [{ name: 'a', versions: ['1'], license: 'MIT' }] });
    expect(res.code).toBe(1);
    expect(res.err).toContain('exception odd-lib matched no package; remove it');
  });

  it('exits 2 on an empty report', () => {
    const res = run({});
    expect(res.code).toBe(2);
    expect(res.err).toContain('no packages');
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

  it.each([
    ['allow is not a list', { allow: 'MIT', exceptions: [] }],
    ['exceptions is not a list', { allow: [], exceptions: {} }],
    ['an exception has no license', { allow: [], exceptions: [{ name: 'x', reason: 'r' }] }],
    ['an exception has no reason', { allow: [], exceptions: [{ name: 'x', license: 'MPL-2.0' }] }],
    [
      'an exception has both name and pattern',
      { allow: [], exceptions: [{ name: 'x', pattern: '^x$', license: 'MPL-2.0', reason: 'r' }] },
    ],
    ['an exception has neither', { allow: [], exceptions: [{ license: 'MPL-2.0', reason: 'r' }] }],
    [
      'a pattern is not anchored',
      { allow: [], exceptions: [{ pattern: 'lightningcss-.*', license: 'MPL-2.0', reason: 'r' }] },
    ],
  ])('exits 2 when %s', (_name, badPolicy) => {
    const res = run({ MIT: [{ name: 'a', versions: ['1'], license: 'MIT' }] }, badPolicy);
    expect(res.code).toBe(2);
    expect(res.err).toContain('policy');
  });

  it('uses the policy file next to the package by default', () => {
    const input = join(dir, 'report.json');
    writeFileSync(
      input,
      JSON.stringify({
        MIT: [{ name: 'a', versions: ['1'], license: 'MIT' }],
        'MPL-2.0': [
          mpl('lightningcss'),
          mpl('lightningcss-linux-x64-gnu'),
          mpl('axe-core'),
          mpl('@axe-core/playwright'),
        ],
        'CC-BY-4.0': [mpl('caniuse-lite', 'CC-BY-4.0')],
        'MIT-0': [mpl('nodemailer', 'MIT-0')],
      }),
    );
    const code = main(['--input', input], { out: () => undefined, err: () => undefined });
    expect(code).toBe(0);
  });
});

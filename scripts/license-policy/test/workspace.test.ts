import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';
import {
  checkLicenses,
  checkLockfile,
  checkProduction,
  lockfilePackages,
  parsePolicy,
  type LicenseReport,
  type Policy,
} from '../src/policy.ts';

const policyPath = new URL('../policy.json', import.meta.url);
const real: Policy = parsePolicy(JSON.parse(readFileSync(policyPath, 'utf8')));

const pkg = (name: string, license: string, version = '1.0.0') => ({
  name,
  versions: [version],
  license,
});

// Every exception in the real policy, so tests can add one package and see only its effect.
const installed: LicenseReport = {
  'MPL-2.0': [
    pkg('lightningcss', 'MPL-2.0'),
    pkg('lightningcss-darwin-arm64', 'MPL-2.0'),
    pkg('axe-core', 'MPL-2.0', '4.14.0'),
    pkg('@axe-core/playwright', 'MPL-2.0', '4.14.0'),
  ],
  'CC-BY-4.0': [pkg('caniuse-lite', 'CC-BY-4.0', '1.0.30001750')],
  MIT: [pkg('left-pad', 'MIT')],
};

function withExtra(extra: { name: string; versions: string[]; license: string }): LicenseReport {
  return { ...installed, [`extra ${extra.license}`]: [extra] };
}

describe('policy.json', () => {
  it('holds exactly these exceptions, new ones by exact name only', () => {
    expect(real.exceptions.map((e) => e.name ?? null)).toEqual([
      'lightningcss',
      null,
      'axe-core',
      '@axe-core/playwright',
      'caniuse-lite',
    ]);
    expect(real.exceptions.filter((e) => e.pattern !== undefined).map((e) => e.pattern)).toEqual([
      '^lightningcss-(darwin|linux|win32|freebsd|android)-(x64|arm64|arm|ia32)(-gnu|-musl|-msvc|-gnueabihf)?$',
    ]);
  });

  it.each([
    ['axe-core', 'MPL-2.0'],
    ['@axe-core/playwright', 'MPL-2.0'],
  ])('excepts %s under %s as dev only', (name, license) => {
    const exception = real.exceptions.find((e) => e.name === name);
    expect(exception?.license).toBe(license);
    expect(exception?.devOnly).toBe(true);
    expect(exception?.reason).toMatch(/^Dev only, never shipped\. \S/);
  });

  // The dashboard ships Next, and Next ships browserslist data from caniuse-lite.
  it('excepts caniuse-lite under CC-BY-4.0 in production, with the reason and its notice', () => {
    const exception = real.exceptions.find((e) => e.name === 'caniuse-lite');
    expect(exception?.license).toBe('CC-BY-4.0');
    expect(exception?.devOnly).toBeUndefined();
    expect(exception?.reason).not.toMatch(/dev only/i);
    expect(exception?.reason).toMatch(/\bNext\b/);
    expect(exception?.reason).toMatch(/THIRD_PARTY_NOTICES\.md/);
  });

  it('forbids sharp by name and @img packages by an anchored pattern', () => {
    expect(real.forbidden.map((f) => f.name ?? f.pattern)).toEqual(['sharp', '^@img/.+$']);
  });

  it('passes the installed set with no unused exception', () => {
    const result = checkLicenses(installed, real);
    expect(result.violations).toEqual([]);
    expect(result.unusedExceptions).toEqual([]);
  });

  it('reports an exception whose package is not installed', () => {
    const report = {
      ...installed,
      'MPL-2.0': installed['MPL-2.0']?.filter((p) => p.name !== '@axe-core/playwright') ?? [],
    };
    expect(checkLicenses(report, real).unusedExceptions).toEqual(['@axe-core/playwright']);
  });
});

describe('near misses of the exact name exceptions', () => {
  it.each([
    ['axe-core-extra', 'MPL-2.0'],
    ['@axe-core/react', 'MPL-2.0'],
    ['axe-core/playwright', 'MPL-2.0'],
    ['caniuse-lite-fork', 'CC-BY-4.0'],
    ['caniuse', 'CC-BY-4.0'],
    ['Caniuse-lite', 'CC-BY-4.0'],
  ])('%s under %s is a violation', (name, license) => {
    const result = checkLicenses(withExtra(pkg(name, license)), real);
    expect(result.violations).toEqual([{ name, versions: ['1.0.0'], license }]);
  });

  it.each(['CC-BY-3.0', 'CC-BY-SA-4.0', 'GPL-3.0', 'MPL-2.0'])(
    'caniuse-lite under %s is a violation naming CC-BY-4.0',
    (license) => {
      const report = { ...installed, 'CC-BY-4.0': [pkg('caniuse-lite', license)] };
      expect(checkLicenses(report, real).violations).toEqual([
        { name: 'caniuse-lite', versions: ['1.0.0'], license, expected: 'CC-BY-4.0' },
      ]);
    },
  );

  it('axe-core under CC-BY-4.0 names MPL-2.0', () => {
    const report = {
      ...installed,
      'MPL-2.0':
        installed['MPL-2.0']?.map((p) =>
          p.name === 'axe-core' ? { ...p, license: 'CC-BY-4.0' } : p,
        ) ?? [],
    };
    expect(checkLicenses(report, real).violations).toEqual([
      { name: 'axe-core', versions: ['4.14.0'], license: 'CC-BY-4.0', expected: 'MPL-2.0' },
    ]);
  });
});

describe('forbidden packages in the licence list', () => {
  it.each([
    ['sharp', 'Apache-2.0', 0],
    ['@img/sharp-libvips-darwin-arm64', 'LGPL-3.0-or-later', 1],
    ['@img/sharp-linux-x64', 'Apache-2.0', 1],
    ['@img/sharp-wasm32', 'Apache-2.0 AND LGPL-3.0-or-later AND MIT', 1],
  ])('refuses %s whatever its licence (%s)', (name, license, entry) => {
    const result = checkLicenses(withExtra(pkg(name, license, '0.34.4')), real);
    const reason = real.forbidden[entry]?.reason;
    expect(reason).toMatch(/\S/);
    expect(result.violations).toEqual([{ name, versions: ['0.34.4'], license, forbidden: reason }]);
  });

  it.each(['sharpen', 'sharp-cli', '@img', 'img/sharp', '@imgix/js-core', '@image/sharp'])(
    'leaves the near miss %s to the licence check',
    (name) => {
      const result = checkLicenses(withExtra(pkg(name, 'MIT')), real);
      expect(result.violations).toEqual([]);
    },
  );
});

const cleanLockfile = `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      eslint-plugin-react-hooks:
        specifier: 7.1.1
        version: 7.1.1(eslint@10.12.0)

packages:

  '@axe-core/playwright@4.14.0':
    resolution: {integrity: sha512-x}
    peerDependencies:
      playwright-core: '>= 1.0.0'

  sharpen@1.0.0:
    resolution: {integrity: sha512-x}

  '@imgix/js-core@3.8.0':
    resolution: {integrity: sha512-x}

snapshots:

  '@axe-core/playwright@4.14.0(playwright-core@1.56.1)':
    dependencies:
      axe-core: 4.14.0
      playwright-core: 1.56.1
`;

// pnpm 9 keys: name@version, quoted when scoped, peers in parentheses on snapshots.
const lockfileV9 = `lockfileVersion: '9.0'

importers:

  apps/dashboard:
    dependencies:
      next:
        specifier: 16.0.0
        version: 16.0.0(react@19.2.0)(sharp@0.34.4)

packages:

  '@img/sharp-libvips-darwin-arm64@1.2.3':
    resolution: {integrity: sha512-x}
    cpu: [arm64]
    os: [darwin]

  '@img/sharp-linux-x64@0.34.4':
    resolution: {integrity: sha512-x}
    cpu: [x64]
    os: [linux]

  sharp@0.34.4:
    resolution: {integrity: sha512-x}

snapshots:

  '@img/sharp-libvips-darwin-arm64@1.2.3':
    optional: true

  '@img/sharp-linux-x64@0.34.4':
    optionalDependencies:
      '@img/sharp-libvips-linux-x64': 1.2.3
    optional: true

  sharp@0.34.4:
    optionalDependencies:
      '@img/sharp-linux-x64': 0.34.4
`;

// pnpm 6 to 8 keys: a leading slash before name@version.
const lockfileV6 = `lockfileVersion: '6.0'

packages:

  /@img/sharp-libvips-darwin-arm64@1.0.4:
    resolution: {integrity: sha512-x}
    os: [darwin]
    optional: true

  /@img/sharp-linux-x64@0.33.5:
    resolution: {integrity: sha512-x}
    optional: true

  /sharp@0.33.5:
    resolution: {integrity: sha512-x}
    requiresBuild: true
    optionalDependencies:
      '@img/sharp-linux-x64': 0.33.5
    dev: false
`;

describe('lockfilePackages', () => {
  it('reads pnpm 9 keys, quoted and with peer suffixes', () => {
    const found = lockfilePackages(cleanLockfile);
    expect(Object.fromEntries(found)).toEqual({
      '@axe-core/playwright': ['4.14.0'],
      sharpen: ['1.0.0'],
      '@imgix/js-core': ['3.8.0'],
    });
  });

  it('reads pnpm 6 keys with a leading slash', () => {
    expect(Object.fromEntries(lockfilePackages(lockfileV6))).toEqual({
      '@img/sharp-libvips-darwin-arm64': ['1.0.4'],
      '@img/sharp-linux-x64': ['0.33.5'],
      sharp: ['0.33.5'],
    });
  });
});

describe('forbidden packages in pnpm-lock.yaml', () => {
  it('passes a lockfile with near misses only', () => {
    expect(checkLockfile(cleanLockfile, real)).toEqual([]);
  });

  it.each([
    [lockfileV9, 'sharp', '0.34.4'],
    [lockfileV9, '@img/sharp-libvips-darwin-arm64', '1.2.3'],
    [lockfileV9, '@img/sharp-linux-x64', '0.34.4'],
    [lockfileV6, 'sharp', '0.33.5'],
    [lockfileV6, '@img/sharp-libvips-darwin-arm64', '1.0.4'],
    [lockfileV6, '@img/sharp-linux-x64', '0.33.5'],
  ])('finds %#: %s@%s', (text, name, version) => {
    const hit = checkLockfile(text, real).find((v) => v.name === name);
    expect(hit?.versions).toEqual([version]);
    expect(hit?.forbidden).toMatch(/\S/);
  });

  it('finds a snapshot written as an empty inline map', () => {
    const text = `lockfileVersion: '9.0'\n\nsnapshots:\n\n  '@img/sharp-darwin-arm64@0.34.4': {}\n`;
    expect(checkLockfile(text, real).map((v) => v.name)).toEqual(['@img/sharp-darwin-arm64']);
  });

  it('finds a platform binary that no machine here would install', () => {
    const text = `lockfileVersion: '9.0'\n\npackages:\n\n  '@img/sharp-win32-x64@0.34.4':\n    resolution: {integrity: sha512-x}\n    os: [win32]\n`;
    expect(checkLockfile(text, real).map((v) => v.name)).toEqual(['@img/sharp-win32-x64']);
  });
});

describe('dev only exceptions in the production tree', () => {
  it('passes when the production tree has none of them', () => {
    expect(checkProduction({ MIT: [pkg('left-pad', 'MIT')] }, real)).toEqual([]);
    expect(checkProduction({}, real)).toEqual([]);
  });

  it.each(['axe-core', '@axe-core/playwright'])('refuses %s in the production tree', (name) => {
    const report = { 'MPL-2.0': [pkg(name, 'MPL-2.0')], MIT: [pkg('left-pad', 'MIT')] };
    expect(checkProduction(report, real)).toEqual([
      { name, versions: ['1.0.0'], license: 'MPL-2.0', devOnly: true },
    ]);
  });

  it('allows caniuse-lite in the production tree', () => {
    const report = { 'CC-BY-4.0': [pkg('caniuse-lite', 'CC-BY-4.0', '1.0.30001750')] };
    expect(checkProduction(report, real)).toEqual([]);
  });

  it('ignores exceptions without devOnly', () => {
    expect(checkProduction({ 'MPL-2.0': [pkg('lightningcss', 'MPL-2.0')] }, real)).toEqual([]);
  });

  it('rejects a production report that is not grouped lists', () => {
    expect(() => checkProduction({ MIT: 'nope' } as never, real)).toThrow(/report/);
  });
});

describe('policy loading', () => {
  const base = { allow: ['MIT'], exceptions: [] };

  it('defaults to no forbidden packages', () => {
    expect(parsePolicy(base).forbidden).toEqual([]);
  });

  it.each([
    ['forbidden is not a list', { ...base, forbidden: 'sharp' }],
    ['a forbidden entry has no reason', { ...base, forbidden: [{ name: 'sharp' }] }],
    [
      'a forbidden pattern is not anchored',
      { ...base, forbidden: [{ pattern: '@img/.+', reason: 'r' }] },
    ],
    [
      'a forbidden pattern is anchored at one end only',
      { ...base, forbidden: [{ pattern: '^@img/.+', reason: 'r' }] },
    ],
    [
      'a forbidden entry has both name and pattern',
      { ...base, forbidden: [{ name: 'sharp', pattern: '^sharp$', reason: 'r' }] },
    ],
    ['a forbidden entry is not an object', { ...base, forbidden: ['sharp'] }],
    [
      'devOnly is not a boolean',
      {
        ...base,
        exceptions: [{ name: 'x', license: 'MPL-2.0', reason: 'r', devOnly: 'yes' }],
      },
    ],
  ])('refuses a policy where %s', (_name, raw) => {
    expect(() => parsePolicy(raw)).toThrow(/invalid policy/);
  });
});

describe('license-policy cli with lockfile and production tree', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'license-policy-ws-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(files: { report?: unknown; lockfile?: string; prod?: string }) {
    const args = ['--input', join(dir, 'report.json')];
    writeFileSync(join(dir, 'report.json'), JSON.stringify(files.report ?? installed));
    if (files.lockfile !== undefined) {
      writeFileSync(join(dir, 'pnpm-lock.yaml'), files.lockfile);
      args.push('--lockfile', join(dir, 'pnpm-lock.yaml'));
    }
    if (files.prod !== undefined) {
      writeFileSync(join(dir, 'prod.json'), files.prod);
      args.push('--prod-input', join(dir, 'prod.json'));
    }
    let out = '';
    let err = '';
    const code = main(args, { out: (s) => (out += s), err: (s) => (err += s) });
    return { code, out, err };
  }

  it('passes the installed set with a clean lockfile and an empty production tree', () => {
    // pnpm prints this instead of JSON when the production tree is empty.
    const res = run({ lockfile: cleanLockfile, prod: 'No licenses in packages found\n' });
    expect(res.err).toBe('');
    expect(res.code).toBe(0);
    expect(res.out).toContain(
      'licenses: 6 packages checked, 5 by exception (@axe-core/playwright, axe-core, caniuse-lite, lightningcss, lightningcss-darwin-arm64), 0 violations',
    );
    expect(res.out).toContain('lockfile: 3 packages checked, 0 forbidden');
    expect(res.out).toContain('production: 0 packages checked, 0 dev only');
  });

  it('names a forbidden package in the licence list', () => {
    const res = run({ report: withExtra(pkg('sharp', 'Apache-2.0', '0.34.4')) });
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/^sharp@0\.34\.4: forbidden in this workspace \(.+\)$/m);
  });

  it('names a forbidden package in the lockfile', () => {
    const res = run({ lockfile: lockfileV9 });
    expect(res.code).toBe(1);
    expect(res.err).toMatch(
      /^@img\/sharp-libvips-darwin-arm64@1\.2\.3: forbidden in this workspace, found in pnpm-lock\.yaml \(.+\)$/m,
    );
    expect(res.err).toMatch(/^sharp@0\.34\.4: forbidden in this workspace, found in/m);
    expect(res.out).toContain('lockfile: 3 packages checked, 3 forbidden');
  });

  it('names a dev only package in the production tree', () => {
    const prod = JSON.stringify({ 'MPL-2.0': [pkg('axe-core', 'MPL-2.0', '4.14.0')] });
    const res = run({ prod });
    expect(res.code).toBe(1);
    expect(res.err).toContain('axe-core@4.14.0: dev only exception found in the production tree');
  });

  it('exits 2 on a production report that is neither JSON nor the empty message', () => {
    const res = run({ prod: 'something broke' });
    expect(res.code).toBe(2);
    expect(res.err).toContain('licenses: error');
  });

  it('exits 2 on a lockfile with no packages, which means it is not a pnpm lockfile', () => {
    const res = run({ lockfile: 'hello: world\n' });
    expect(res.code).toBe(2);
    expect(res.err).toContain('lockfile lists no packages');
  });
});

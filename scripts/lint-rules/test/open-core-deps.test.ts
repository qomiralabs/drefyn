import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkLockfile,
  checkManifests,
  checkOpenCore,
  checkSources,
  isStripePackage,
  parseLockfile,
} from '../src/open-core-deps.ts';
import { repoRoot } from './helpers.ts';

let root: string;

const write = (path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

const manifest = (dir: string, body: Record<string, unknown>) => {
  write(`${dir}/package.json`, JSON.stringify(body, null, 2));
};

// The shape pnpm 10 writes: importers by path, then one snapshot per resolved version.
const lockfile = (importers: string, snapshots: string) =>
  `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n\nimporters:\n\n${importers}\npackages:\n\n  left-pad@1.3.0:\n    resolution: {integrity: sha512-x}\n\nsnapshots:\n\n${snapshots}`;

const cleanImporters = `  .:
    devDependencies:
      typescript:
        specifier: 6.0.3
        version: 6.0.3

  packages/a:
    dependencies:
      '@drefyn/b':
        specifier: workspace:*
        version: link:../b
      left-pad:
        specifier: 1.3.0
        version: 1.3.0

  packages/b:
    dependencies:
      wrapper:
        specifier: 2.0.0
        version: 2.0.0(react@19.0.0)
`;

const cleanSnapshots = `  left-pad@1.3.0: {}

  typescript@6.0.3: {}

  react@19.0.0: {}

  wrapper@2.0.0(react@19.0.0):
    dependencies:
      left-pad: 1.3.0
    optionalDependencies:
      react: 19.0.0
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'open-core-deps-'));
  manifest('packages/a', { name: '@drefyn/a', dependencies: { '@drefyn/b': 'workspace:*' } });
  manifest('packages/b', { name: '@drefyn/b', dependencies: { wrapper: '2.0.0' } });
  write('pnpm-lock.yaml', lockfile(cleanImporters, cleanSnapshots));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('isStripePackage', () => {
  it.each([
    'stripe',
    '@stripe/stripe-js',
    '@stripe/react-stripe-js',
    'react-stripe-js',
    'stripe-node',
  ])('flags %s', (name) => {
    expect(isStripePackage(name)).toBe(true);
  });

  it.each(['pinstripe', 'stripes', '@drefyn/billing-contract', 'striped-table', 'left-pad'])(
    'leaves %s alone',
    (name) => {
      expect(isStripePackage(name)).toBe(false);
    },
  );
});

describe('the current tree', () => {
  it('has no stripe dependency, lockfile entry or import in shipped code', () => {
    expect(checkOpenCore(repoRoot)).toEqual([]);
  });

  it('reads every importer in the real lockfile', () => {
    // Proves the parser understood the real file, not that it found nothing to read.
    const parsed = parseLockfile(readLock(repoRoot));
    expect(parsed.importers.size).toBeGreaterThan(10);
    expect(parsed.importers.get('packages/entitlements')).toBeDefined();
    expect(parsed.snapshots.size).toBeGreaterThan(100);
  });
});

describe('manifests', () => {
  it('passes clean manifests', () => {
    expect(checkManifests(root)).toEqual([]);
  });

  it.each(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'])(
    'names the package that lists stripe in %s',
    (field) => {
      manifest('apps/web', { name: '@drefyn/web', [field]: { stripe: '20.0.0' } });
      expect(checkManifests(root)).toEqual([
        { package: '@drefyn/web', reason: `lists stripe in ${field}` },
      ]);
    },
  );

  it('flags Stripe.js', () => {
    manifest('packages/b', { name: '@drefyn/b', dependencies: { '@stripe/stripe-js': '7.0.0' } });
    expect(checkManifests(root)).toEqual([
      { package: '@drefyn/b', reason: 'lists @stripe/stripe-js in dependencies' },
    ]);
  });

  it('fails loudly on a manifest it cannot read', () => {
    write('packages/c/package.json', '{ not json');
    expect(() => checkManifests(root)).toThrow(/packages\/c\/package\.json/);
  });
});

describe('lockfile', () => {
  it('passes a clean lockfile', () => {
    expect(checkLockfile(root)).toEqual([]);
  });

  it('names the importer with a direct stripe dependency', () => {
    write(
      'pnpm-lock.yaml',
      lockfile(
        cleanImporters +
          `      stripe:
        specifier: 20.0.0
        version: 20.0.0
`,
        cleanSnapshots + '\n  stripe@20.0.0: {}\n',
      ),
    );
    expect(checkLockfile(root)).toEqual(
      [
        { package: '@drefyn/b', reason: 'depends on stripe@20.0.0 (via stripe@20.0.0)' },
        // a reaches it through its workspace link to b.
        {
          package: '@drefyn/a',
          reason: 'depends on stripe@20.0.0 (via @drefyn/b > stripe@20.0.0)',
        },
      ].sort(byPackage),
    );
  });

  it('names every importer that reaches stripe through a dependency', () => {
    const snapshots = cleanSnapshots
      .replace(
        '      left-pad: 1.3.0\n',
        "      left-pad: 1.3.0\n      '@stripe/stripe-js': 7.1.0\n",
      )
      .concat("\n  '@stripe/stripe-js@7.1.0': {}\n");
    write('pnpm-lock.yaml', lockfile(cleanImporters, snapshots));
    expect(checkLockfile(root).sort(byPackage)).toEqual([
      {
        package: '@drefyn/a',
        reason:
          'depends on @stripe/stripe-js@7.1.0 (via @drefyn/b > wrapper@2.0.0(react@19.0.0) > @stripe/stripe-js@7.1.0)',
      },
      {
        package: '@drefyn/b',
        reason:
          'depends on @stripe/stripe-js@7.1.0 (via wrapper@2.0.0(react@19.0.0) > @stripe/stripe-js@7.1.0)',
      },
    ]);
  });

  it('survives a dependency cycle', () => {
    const snapshots = cleanSnapshots.replace(
      '  left-pad@1.3.0: {}\n',
      '  left-pad@1.3.0:\n    dependencies:\n      wrapper: 2.0.0(react@19.0.0)\n',
    );
    write('pnpm-lock.yaml', lockfile(cleanImporters, snapshots));
    expect(checkLockfile(root)).toEqual([]);
  });

  it('falls back to the importer path when it has no manifest', () => {
    write(
      'pnpm-lock.yaml',
      lockfile(
        cleanImporters +
          `
  packages/gone:
    dependencies:
      stripe:
        specifier: 20.0.0
        version: 20.0.0
`,
        cleanSnapshots + '\n  stripe@20.0.0: {}\n',
      ),
    );
    expect(checkLockfile(root)).toEqual([
      { package: 'packages/gone', reason: 'depends on stripe@20.0.0 (via stripe@20.0.0)' },
    ]);
  });

  it('fails loudly on a lockfile version it does not know', () => {
    write('pnpm-lock.yaml', "lockfileVersion: '10.0'\n");
    expect(() => checkLockfile(root)).toThrow(/lockfile version '10.0'/);
  });

  it('fails loudly when a dependency points at no snapshot', () => {
    write('pnpm-lock.yaml', lockfile(cleanImporters, '  typescript@6.0.3: {}\n'));
    expect(() => checkLockfile(root)).toThrow(/packages\/a: left-pad@1\.3\.0 has no snapshot/);
  });

  it('fails loudly on an empty lockfile', () => {
    write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
    expect(() => checkLockfile(root)).toThrow(/no importers/);
  });

  it('fails loudly on a line it cannot place', () => {
    write('pnpm-lock.yaml', lockfile(cleanImporters + '        surprise\n', cleanSnapshots));
    expect(() => checkLockfile(root)).toThrow(/line \d+/);
  });
});

describe('sources', () => {
  it('passes code that only mentions billing in words', () => {
    write('packages/a/src/index.ts', "// card ending 4242\nexport const a = 'pinstripe';\n");
    expect(checkSources(root)).toEqual([]);
  });

  it.each([
    ["import Stripe from 'stripe';", 'imports stripe'],
    ["import { loadStripe } from '@stripe/stripe-js';", 'imports @stripe/stripe-js'],
    ['export * from "stripe";', 'imports stripe'],
    ["const s = await import('stripe');", 'imports stripe'],
    ["const s = require('stripe/lib/x');", 'imports stripe/lib/x'],
    ["import 'stripe';", 'imports stripe'],
    ["const src = 'https://js.stripe.com/v3';", 'loads js.stripe.com'],
  ])('flags %s', (code, reason) => {
    manifest('apps/web', { name: '@drefyn/web' });
    write('apps/web/src/pay.tsx', `${code}\n`);
    expect(checkSources(root)).toEqual([
      { package: '@drefyn/web', reason: `${reason} in apps/web/src/pay.tsx` },
    ]);
  });

  it('scans app files outside src, such as a config', () => {
    manifest('apps/web', { name: '@drefyn/web' });
    write('apps/web/next.config.ts', "const csp = 'script-src js.stripe.com';\n");
    expect(checkSources(root)).toEqual([
      { package: '@drefyn/web', reason: 'loads js.stripe.com in apps/web/next.config.ts' },
    ]);
  });

  it.each([
    'packages/a/test/pay.test.ts',
    'packages/a/src/pay.test.ts',
    'packages/a/e2e/pay.ts',
    'packages/a/node_modules/stripe/index.js',
    'packages/a/dist/index.js',
    'packages/a/README.md',
  ])('leaves %s alone, since it never ships', (path) => {
    write(path, "import Stripe from 'stripe';\n");
    expect(checkSources(root)).toEqual([]);
  });
});

describe('checkOpenCore', () => {
  it('reports from every source, sorted by package', () => {
    manifest('packages/b', { name: '@drefyn/b', dependencies: { stripe: '20.0.0' } });
    write('packages/a/src/index.ts', "import 'stripe';\n");
    expect(checkOpenCore(root)).toEqual([
      { package: '@drefyn/a', reason: 'imports stripe in packages/a/src/index.ts' },
      { package: '@drefyn/b', reason: 'lists stripe in dependencies' },
    ]);
  });
});

function byPackage(a: { package: string; reason: string }, b: { package: string; reason: string }) {
  return a.package === b.package
    ? a.reason.localeCompare(b.reason)
    : a.package.localeCompare(b.package);
}

function readLock(dir: string): string {
  return readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8');
}

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createHostResolver,
  HostLookupError,
  normalizeHost,
  type HostResolverOptions,
  type SiteDirectory,
} from '../src/index.ts';
import {
  captureLogger,
  DOMAINS,
  fakeDirectory,
  ORG_A,
  ORG_B,
  PRJ_A,
  PRJ_B,
  rowA,
  SITE_A,
  SITE_B,
} from './support.ts';

const resolver = (options: Partial<HostResolverOptions> = {}) =>
  createHostResolver({ domains: DOMAINS, directory: fakeDirectory(), ...options });

const siteA = {
  kind: 'site',
  tenant: { organizationId: ORG_A, projectId: PRJ_A },
  siteId: SITE_A,
  access: 'public',
};
const siteB = {
  kind: 'site',
  tenant: { organizationId: ORG_B, projectId: PRJ_B },
  siteId: SITE_B,
  access: 'public',
};
const UNKNOWN = { kind: 'unknown' };

describe('normalizeHost', () => {
  it.each([
    ['alpha.drefyn.test', 'alpha.drefyn.test'],
    ['Alpha.Drefyn.TEST', 'alpha.drefyn.test'],
    ['alpha.drefyn.test:443', 'alpha.drefyn.test'],
    ['docs.alpha.example:8080', 'docs.alpha.example'],
    ['xn--bcher-kva.example', 'xn--bcher-kva.example'],
    ['localhost:3000', 'localhost'],
  ])('reads %s as %s', (raw, host) => {
    expect(normalizeHost(raw)).toBe(host);
  });

  it.each([
    [undefined],
    [''],
    [' alpha.drefyn.test'],
    ['alpha.drefyn.test.'],
    ['alpha..drefyn.test'],
    ['.drefyn.test'],
    ['-alpha.drefyn.test'],
    ['alpha-.drefyn.test'],
    ['al_pha.drefyn.test'],
    ['user@alpha.drefyn.test'],
    ['alpha.drefyn.test:'],
    ['alpha.drefyn.test:99999'],
    ['alpha.drefyn.test:80:80'],
    ['alpha.drefyn.test/path'],
    ['alpha.drefyn.test, beta.drefyn.test'],
    ['127.0.0.1'],
    ['127.0.0.1:3000'],
    ['10.1'],
    ['[::1]'],
    ['[::1]:3000'],
    ['bücher.example'],
    [`${'a'.repeat(64)}.drefyn.test`],
    [`${'abcdefghi.'.repeat(26)}test`],
  ])('refuses %j', (raw) => {
    expect(normalizeHost(raw)).toBeNull();
  });
});

describe('resolveHost', () => {
  it('resolves a site under the base domain to its own tenant', async () => {
    const hosts = resolver();
    expect(await hosts.resolveHost('alpha.drefyn.test')).toEqual(siteA);
    expect(await hosts.resolveHost('BETA.drefyn.test:443')).toEqual(siteB);
  });

  it('resolves a verified custom domain that is still attached', async () => {
    expect(await resolver().resolveHost('docs.alpha.example')).toEqual(siteA);
  });

  it('carries a private site as private, so nothing public serves it', async () => {
    const directory = fakeDirectory({ subdomains: { alpha: { ...rowA, access: 'private' } } });
    expect(await resolver({ directory }).resolveHost('alpha.drefyn.test')).toEqual({
      ...siteA,
      access: 'private',
    });
  });

  it('has no preview hosts yet: a name under preview resolves to nobody', async () => {
    expect(await resolver().resolveHost('alpha.preview.drefyn.test')).toEqual(UNKNOWN);
  });

  it.each([
    ['a subdomain nobody holds', 'gamma.drefyn.test'],
    ['the base domain itself', 'drefyn.test'],
    ['the status name under the suffix', 'status.drefyn.test'],
    ['a status page host', 'alpha.status.drefyn.test'],
    ['two labels under the base', 'www.alpha.drefyn.test'],
    ['a custom domain never verified', 'pending.alpha.example'],
    ['a custom domain detached after verification', 'old.beta.example'],
    ['a custom domain nobody added', 'docs.gamma.example'],
    ['the dashboard host', 'app.drefyn.dev'],
    ['a name under the dashboard host', 'alpha.app.drefyn.dev'],
    ['an address', '127.0.0.1'],
    ['nothing at all', ''],
  ])('answers unknown for %s', async (_name, host) => {
    expect(await resolver().resolveHost(host)).toEqual(UNKNOWN);
  });

  it('never asks the custom domain table about a name under our own domains', async () => {
    const directory = fakeDirectory({
      custom: {
        'www.alpha.drefyn.test': rowA,
        'blog.status.drefyn.test': rowA,
        'app.drefyn.dev': rowA,
      },
    });
    const hosts = resolver({ directory });
    expect(await hosts.resolveHost('www.alpha.drefyn.test')).toEqual(UNKNOWN);
    expect(await hosts.resolveHost('blog.status.drefyn.test')).toEqual(UNKNOWN);
    expect(await hosts.resolveHost('alpha.app.drefyn.dev')).toEqual(UNKNOWN);
    expect(await hosts.resolveHost('app.drefyn.dev')).toEqual(UNKNOWN);
    expect(await hosts.resolveHost('drefyn.test')).toEqual(UNKNOWN);
    expect(directory.calls).toEqual([]);
  });

  it.each(['status', 'preview', 'www'])(
    'never resolves the reserved name %s under the suffix, even with a row for it',
    async (name) => {
      const directory = fakeDirectory({ subdomains: { [name]: rowA } });
      const hosts = resolver({ directory });
      expect(await hosts.resolveHost(`${name}.drefyn.test`)).toEqual(UNKNOWN);
      expect(directory.calls).toEqual([]);
    },
  );

  it('keeps reserving a parent of the suffix when it has one', async () => {
    const directory = fakeDirectory({ custom: { 'blog.example.org': rowA } });
    const hosts = createHostResolver({
      domains: {
        hostSuffix: 'docs.example.org',
        reservedDomain: 'example.org',
        dashboardHost: 'app.example.org',
      },
      directory,
    });
    expect(await hosts.resolveHost('alpha.docs.example.org')).toEqual(siteA);
    expect(await hosts.resolveHost('blog.example.org')).toEqual(UNKNOWN);
    expect(await hosts.resolveHost('example.org')).toEqual(UNKNOWN);
    expect(directory.calls).toEqual(['sub:alpha']);
  });

  it('refuses a record for a name other than the one asked', async () => {
    const directory: SiteDirectory = {
      bySubdomain: () => Promise.resolve({ subdomain: 'beta', ...rowA }),
      byCustomDomain: () => Promise.resolve(null),
    };
    const failure = await resolver({ directory })
      .resolveHost('alpha.drefyn.test')
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HostLookupError);
    expect((failure as HostLookupError).code).toBe('site.directory_invalid');
  });

  it.each([
    ['a malformed organization id', { subdomain: 'alpha', ...rowA, organizationId: 'org_1' }],
    ['an unknown access value', { subdomain: 'alpha', ...rowA, access: 'everyone' }],
    ['a missing site id', { subdomain: 'alpha', organizationId: ORG_A, projectId: PRJ_A }],
    ['a string instead of a record', 'alpha'],
  ])('refuses %s from the directory', async (_name, record) => {
    const directory: SiteDirectory = {
      bySubdomain: () => Promise.resolve(record),
      byCustomDomain: () => Promise.resolve(null),
    };
    await expect(resolver({ directory }).resolveHost('alpha.drefyn.test')).rejects.toMatchObject({
      code: 'site.directory_invalid',
    });
  });

  it('refuses a custom domain record without its verification fields', async () => {
    const directory: SiteDirectory = {
      bySubdomain: () => Promise.resolve(null),
      byCustomDomain: (domain) => Promise.resolve({ domain, ...rowA }),
    };
    await expect(resolver({ directory }).resolveHost('docs.alpha.example')).rejects.toMatchObject({
      code: 'site.directory_invalid',
    });
  });

  it('fails closed when the directory throws, and logs only a code', async () => {
    const { lines, logger } = captureLogger();
    const directory: SiteDirectory = {
      bySubdomain: () => Promise.reject(new Error('connection refused to 10.0.0.5 for alpha')),
      byCustomDomain: () => Promise.resolve(null),
    };
    await expect(
      resolver({ directory, logger }).resolveHost('alpha.drefyn.test'),
    ).rejects.toMatchObject({ code: 'site.directory_failed' });
    expect(lines).toEqual([
      { level: 'error', event: 'site.directory_failed', fields: { code: 'site.directory_failed' } },
    ]);
  });

  it('gives up on a slow directory and aborts its lookup', async () => {
    let aborted = false;
    const directory: SiteDirectory = {
      bySubdomain: (_subdomain, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
      byCustomDomain: () => Promise.resolve(null),
    };
    await expect(
      resolver({ directory, timeoutMs: 20 }).resolveHost('alpha.drefyn.test'),
    ).rejects.toMatchObject({ code: 'site.directory_timeout' });
    expect(aborted).toBe(true);
  });

  it('times out a directory that ignores the abort signal', async () => {
    const directory: SiteDirectory = {
      bySubdomain: () => new Promise(() => undefined),
      byCustomDomain: () => Promise.resolve(null),
    };
    await expect(
      resolver({ directory, timeoutMs: 20 }).resolveHost('alpha.drefyn.test'),
    ).rejects.toMatchObject({ code: 'site.directory_timeout' });
  });

  it.each([
    ['maxEntries', { maxEntries: 0 }],
    ['ttlMs', { ttlMs: -1 }],
    ['unknownTtlMs', { unknownTtlMs: 1.5 }],
    ['timeoutMs', { timeoutMs: 0 }],
  ])('refuses a bad %s', (_name, options) => {
    expect(() => resolver(options)).toThrow(RangeError);
  });
});

describe('the resolution cache', () => {
  it('keeps an answer for its lifetime and asks again after it', async () => {
    let now = 0;
    const directory = fakeDirectory();
    const hosts = resolver({ directory, ttlMs: 1000, now: () => now });
    await hosts.resolveHost('alpha.drefyn.test');
    now = 999;
    expect(await hosts.resolveHost('ALPHA.drefyn.test:443')).toEqual(siteA);
    expect(directory.calls).toEqual(['sub:alpha']);
    now = 1000;
    await hosts.resolveHost('alpha.drefyn.test');
    expect(directory.calls).toEqual(['sub:alpha', 'sub:alpha']);
  });

  it('keeps an unknown answer for less time, so a new site shows up soon', async () => {
    let now = 0;
    const directory = fakeDirectory();
    const hosts = resolver({ directory, ttlMs: 1000, unknownTtlMs: 100, now: () => now });
    await hosts.resolveHost('gamma.drefyn.test');
    now = 99;
    await hosts.resolveHost('gamma.drefyn.test');
    expect(directory.calls).toEqual(['sub:gamma']);
    now = 100;
    await hosts.resolveHost('gamma.drefyn.test');
    expect(directory.calls).toEqual(['sub:gamma', 'sub:gamma']);
  });

  it('shares one lookup between requests that miss together', async () => {
    const directory = fakeDirectory();
    const hosts = resolver({ directory });
    const answers = await Promise.all([
      hosts.resolveHost('alpha.drefyn.test'),
      hosts.resolveHost('alpha.drefyn.test'),
      hosts.resolveHost('alpha.drefyn.test'),
    ]);
    expect(answers).toEqual([siteA, siteA, siteA]);
    expect(directory.calls).toEqual(['sub:alpha']);
  });

  it('does not keep a failure', async () => {
    let fail = true;
    const inner = fakeDirectory();
    const directory: SiteDirectory = {
      bySubdomain: (subdomain, signal) =>
        fail ? Promise.reject(new Error('down')) : inner.bySubdomain(subdomain, signal),
      byCustomDomain: (domain, signal) => inner.byCustomDomain(domain, signal),
    };
    const hosts = resolver({ directory });
    await expect(hosts.resolveHost('alpha.drefyn.test')).rejects.toBeInstanceOf(HostLookupError);
    fail = false;
    expect(await hosts.resolveHost('alpha.drefyn.test')).toEqual(siteA);
  });

  it('holds at most maxEntries hosts, dropping the least recently used', async () => {
    const directory = fakeDirectory();
    const hosts = resolver({ directory, maxEntries: 2 });
    await hosts.resolveHost('alpha.drefyn.test');
    await hosts.resolveHost('beta.drefyn.test');
    await hosts.resolveHost('alpha.drefyn.test');
    await hosts.resolveHost('gamma.drefyn.test');
    await hosts.resolveHost('alpha.drefyn.test');
    await hosts.resolveHost('beta.drefyn.test');
    expect(directory.calls).toEqual(['sub:alpha', 'sub:beta', 'sub:gamma', 'sub:beta']);
  });

  it('does not spend an entry or a lookup on a host that cannot be one', async () => {
    const directory = fakeDirectory();
    const hosts = resolver({ directory, maxEntries: 1 });
    await hosts.resolveHost('alpha.drefyn.test');
    await hosts.resolveHost('not a host');
    await hosts.resolveHost('alpha.drefyn.test');
    expect(directory.calls).toEqual(['sub:alpha']);
  });
});

// Hosts an attacker might send: real names with a twist, names of the other tenant, and noise.
const label = fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,8}[a-z0-9])?$/);
const twist = fc.constantFrom(
  (h: string) => h,
  (h: string) => h.toUpperCase(),
  (h: string) => `${h}.`,
  (h: string) => `${h}:443`,
  (h: string) => `www.${h}`,
  (h: string) => `${h}.evil.example`,
  (h: string) => `evil-${h}`,
  (h: string) => `${h} `,
  (h: string) => `${h}\u0000`,
  (h: string) => `user@${h}`,
  (h: string) => `${h},beta.drefyn.test`,
);
const forgedHost = fc.oneof(
  fc
    .tuple(
      fc.constantFrom(
        'alpha.drefyn.test',
        'beta.drefyn.test',
        'docs.alpha.example',
        'docs.beta.example',
        'pending.alpha.example',
        'old.beta.example',
        'alpha.preview.drefyn.test',
        'drefyn.test',
        'drefyn.test',
        'app.drefyn.dev',
      ),
      twist,
    )
    .map(([host, change]) => change(host)),
  fc
    .tuple(label, fc.constantFrom('drefyn.test', 'drefyn.test', 'app.drefyn.dev'))
    .map(([first, rest]) => `${first}.${rest}`),
  fc.string({ maxLength: 40 }),
  fc.domain(),
);

describe('forged hosts', () => {
  it('never resolve without a directory row for exactly that name', async () => {
    const empty: SiteDirectory = {
      bySubdomain: () => Promise.resolve(null),
      byCustomDomain: () => Promise.resolve(null),
    };
    const hosts = resolver({ directory: empty });
    await fc.assert(
      fc.asyncProperty(forgedHost, async (host) => {
        expect(await hosts.resolveHost(host)).toEqual(UNKNOWN);
      }),
    );
  });

  it('resolve only to the tenant that holds the name, or to nothing', async () => {
    const hosts = resolver();
    const owners: Readonly<Record<string, string>> = {
      'alpha.drefyn.test': ORG_A,
      'docs.alpha.example': ORG_A,
      'beta.drefyn.test': ORG_B,
      'docs.beta.example': ORG_B,
    };
    await fc.assert(
      fc.asyncProperty(forgedHost, async (host) => {
        const answer = await hosts.resolveHost(host);
        if (answer.kind === 'unknown') return;
        const name = normalizeHost(host);
        expect(name).not.toBeNull();
        expect(answer.tenant.organizationId).toBe(owners[name ?? '']);
      }),
    );
  });
});

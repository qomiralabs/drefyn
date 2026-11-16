import { describe, expect, it } from 'vitest';
import {
  createApp,
  createHostResolver,
  type DocsSiteDeps,
  type SiteDirectory,
} from '../src/index.ts';
import {
  captureLogger,
  DOMAINS,
  fakeDirectory,
  flagsOnFor,
  ORG_A,
  ORG_B,
  PRJ_A,
  PRJ_B,
  rowA,
  SITE_A,
  SITE_B,
} from './support.ts';

// Page routes arrive with the templates. This probe stands in for them and echoes whose site
// the request resolved to.
function appWith(overrides: Partial<DocsSiteDeps> & { directory?: SiteDirectory } = {}) {
  const directory = overrides.directory ?? fakeDirectory();
  const { lines, logger } = captureLogger();
  const flags = flagsOnFor(ORG_A, ORG_B);
  const app = createApp({
    resolver: overrides.resolver ?? createHostResolver({ domains: DOMAINS, directory, logger }),
    flags: overrides.flags ?? flags.client,
    logger: overrides.logger ?? logger,
  });
  app.get('/probe', (c) => {
    const site = c.get('site');
    return c.json({
      organizationId: site.tenant.organizationId,
      projectId: site.tenant.projectId,
      siteId: site.siteId,
    });
  });
  return { app, directory, lines, asked: flags.asked };
}

const get = (
  app: ReturnType<typeof appWith>['app'],
  host: string | undefined,
  headers: Record<string, string> = {},
  path = '/probe',
) =>
  app.request(`http://ignored.invalid${path}`, {
    headers: host === undefined ? headers : { host, ...headers },
  });

const A = { organizationId: ORG_A, projectId: PRJ_A, siteId: SITE_A };
const B = { organizationId: ORG_B, projectId: PRJ_B, siteId: SITE_B };

describe('requests by host', () => {
  it('serves each tenant only on its own host', async () => {
    const { app } = appWith();
    expect(await (await get(app, 'alpha.drefyn.test')).json()).toEqual(A);
    expect(await (await get(app, 'docs.beta.example')).json()).toEqual(B);
  });

  it.each([
    ['an unknown host', 'gamma.drefyn.test'],
    ['the bare base domain', 'drefyn.test'],
    ['an unverified custom domain', 'pending.alpha.example'],
    ['a detached custom domain', 'old.beta.example'],
    ['the dashboard host', 'app.drefyn.dev'],
    ['the status name under the suffix', 'status.drefyn.test'],
    ['a status page host', 'alpha.status.drefyn.test'],
    ['an address', '127.0.0.1'],
    ['a malformed host', 'alpha.drefyn.test, beta.drefyn.test'],
  ])('answers 404 for %s, the same as any missing page', async (_name, host) => {
    const { app } = appWith();
    const response = await get(app, host);
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('Not found');
  });

  it('answers 404 with no Host header at all', async () => {
    const { app } = appWith();
    const response = await get(app, undefined);
    expect(response.status).toBe(404);
  });

  it('answers 404 on a known host for a path nothing serves', async () => {
    const { app } = appWith();
    const response = await get(app, 'alpha.drefyn.test', {}, '/nothing-here');
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
  });

  it('does not serve a private site before its reader checks exist', async () => {
    const directory = fakeDirectory({ subdomains: { alpha: { ...rowA, access: 'private' } } });
    const { app } = appWith({ directory });
    expect((await get(app, 'alpha.drefyn.test')).status).toBe(404);
  });

  it('sets no cookie on any answer', async () => {
    const { app } = appWith();
    for (const host of ['alpha.drefyn.test', 'gamma.drefyn.test', 'drefyn.test']) {
      expect((await get(app, host)).headers.get('set-cookie')).toBeNull();
    }
  });

  it('answers 503 and serves nothing when the directory is down', async () => {
    const directory: SiteDirectory = {
      bySubdomain: () => Promise.reject(new Error('down')),
      byCustomDomain: () => Promise.reject(new Error('down')),
    };
    const { app } = appWith({ directory });
    const response = await get(app, 'alpha.drefyn.test');
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('retry-after')).toBe('5');
  });

  it('lets an error it did not expect through to the 500 handler', async () => {
    const { app } = appWith({
      resolver: { resolveHost: () => Promise.reject(new Error('bug')) },
    });
    const response = await get(app, 'alpha.drefyn.test');
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Internal error');
  });
});

describe('forwarded host headers', () => {
  const forged = (target: string) => ({
    'x-forwarded-host': target,
    forwarded: `for=203.0.113.9;host=${target};proto=https`,
    'x-original-host': target,
  });

  it('are ignored: the request is served for its Host, not the forged one', async () => {
    const { app } = appWith();
    expect(await (await get(app, 'alpha.drefyn.test', forged('beta.drefyn.test'))).json()).toEqual(
      A,
    );
  });

  it('cannot turn an unknown host into a site', async () => {
    const { app, directory } = appWith();
    const response = await get(app, 'gamma.drefyn.test', forged('alpha.drefyn.test'));
    expect(response.status).toBe(404);
    expect(directory.calls).toEqual(['sub:gamma']);
  });

  it('do not poison the cache for the next request', async () => {
    const { app, directory } = appWith();
    await get(app, 'alpha.drefyn.test', forged('docs.beta.example'));
    await get(app, 'docs.beta.example', forged('alpha.drefyn.test'));
    // Both answers now come from the cache, each still under its own Host.
    expect(await (await get(app, 'alpha.drefyn.test')).json()).toEqual(A);
    expect(await (await get(app, 'docs.beta.example')).json()).toEqual(B);
    expect(directory.calls).toEqual(['sub:alpha', 'custom:docs.beta.example']);
  });
});

describe('the docs.site flag', () => {
  it('serves the site when it is on for the organization, asking with both ids', async () => {
    const { app, asked } = appWith();
    expect((await get(app, 'alpha.drefyn.test')).status).toBe(200);
    expect(asked).toEqual([{ name: 'docs.site', organizationId: ORG_A, projectId: PRJ_A }]);
  });

  it('answers 404 when it is off, exactly as for an unknown host', async () => {
    const off = flagsOnFor(ORG_B);
    const { app } = appWith({ flags: off.client });
    const response = await get(app, 'alpha.drefyn.test');
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
    expect((await get(app, 'beta.drefyn.test')).status).toBe(200);
  });

  it('is not asked for a host that resolves to nobody', async () => {
    const { app, asked } = appWith();
    await get(app, 'gamma.drefyn.test');
    expect(asked).toEqual([]);
  });
});

describe('request logs', () => {
  it('carry ids, outcome and timing, never the host, path or headers', async () => {
    const { app, lines } = appWith();
    await get(app, 'alpha.drefyn.test', { 'x-forwarded-host': 'beta.drefyn.test', cookie: 'a=b' });
    await get(app, 'gamma.drefyn.test', {}, '/secret-page?token=abc');
    await get(app, 'docs.alpha.example', {}, '/nothing-here');
    const served = lines.find((line) => line.fields['outcome'] === 'served');
    expect(served).toMatchObject({
      level: 'info',
      event: 'site.request',
      fields: {
        outcome: 'served',
        organization_id: ORG_A,
        project_id: PRJ_A,
        site_id: SITE_A,
        status: 200,
      },
    });
    expect(typeof served?.fields['duration_ms']).toBe('number');
    expect(lines.find((line) => line.fields['outcome'] === 'unknown')?.fields).toEqual({
      outcome: 'unknown',
      status: 404,
      duration_ms: expect.any(Number) as number,
    });
    const text = JSON.stringify(lines);
    for (const leak of [
      'drefyn.test',
      'alpha.example',
      'gamma',
      'secret-page',
      'token',
      'abc',
      'cookie',
      'nothing-here',
    ]) {
      expect(text).not.toContain(leak);
    }
  });

  it.each([
    ['flag_off', 'alpha.drefyn.test', 404],
    ['private', 'docs.alpha.example', 404],
  ])('name the %s outcome with the tenant ids', async (outcome, host, status) => {
    const directory = fakeDirectory({
      custom: { 'docs.alpha.example': { ...rowA, access: 'private' } },
    });
    const flags = outcome === 'flag_off' ? flagsOnFor().client : flagsOnFor(ORG_A).client;
    const { app, lines } = appWith({ directory, flags });
    expect((await get(app, host)).status).toBe(status);
    expect(lines.at(-1)?.fields).toMatchObject({
      outcome,
      organization_id: ORG_A,
      project_id: PRJ_A,
      site_id: SITE_A,
      status,
    });
  });

  it('name an unavailable directory by code only', async () => {
    const directory: SiteDirectory = {
      bySubdomain: () => Promise.reject(new Error('secret detail')),
      byCustomDomain: () => Promise.resolve(null),
    };
    const { app, lines } = appWith({ directory });
    await get(app, 'alpha.drefyn.test');
    expect(lines.at(-1)).toMatchObject({
      event: 'site.request',
      fields: { outcome: 'unavailable', code: 'site.directory_failed', status: 503 },
    });
    expect(JSON.stringify(lines)).not.toContain('secret detail');
  });

  it('name an unexpected failure as an error without its message', async () => {
    const { lines, logger } = captureLogger();
    const { app } = appWith({
      logger,
      resolver: { resolveHost: () => Promise.reject(new Error('alpha.drefyn.test broke')) },
    });
    await get(app, 'alpha.drefyn.test');
    expect(lines).toEqual([{ level: 'error', event: 'site.request_failed', fields: {} }]);
  });
});

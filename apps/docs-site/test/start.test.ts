import { describe, expect, it } from 'vitest';
import { DocsSiteConfigError, startDocsSite, type RunningDocsSite } from '../src/index.ts';
import { captureLogger, fakeDirectory, flagsOnFor, ORG_A, PRJ_A, rowA, SITE_A } from './support.ts';

// fetch always sends the Host of the URL it is given, so the only loopback name it can carry
// is localhost. The fake directory holds localhost as tenant A's verified custom domain, and
// beta.drefyn.test as tenant B's site, which a forged header then tries to reach.
const ENV = {
  DREFYN_APP_ORIGIN: 'https://app.drefyn.dev',
  DREFYN_DOCS_HOST_SUFFIX: 'drefyn.test',
  DREFYN_DOCS_SITE_PORT: '3002',
};

async function started() {
  const directory = fakeDirectory({ custom: { localhost: rowA } });
  const { lines, logger } = captureLogger();
  const site = await startDocsSite(ENV, {
    directory,
    flags: flagsOnFor(ORG_A).client,
    logger,
    listen: { hostname: '127.0.0.1', port: 0 },
    mount: (app) => {
      app.get('/probe', (c) => c.json(c.get('site')));
    },
  });
  return { site, directory, lines };
}

const call = (site: RunningDocsSite, host: 'localhost' | '127.0.0.1', headers = {}) =>
  fetch(`http://${host}:${String(site.port)}/probe`, {
    headers,
    signal: AbortSignal.timeout(5000),
  });

const forged = {
  'x-forwarded-host': 'beta.drefyn.test',
  forwarded: 'for=203.0.113.9;host=beta.drefyn.test;proto=https',
};

describe('startDocsSite', () => {
  it('ignores forged forwarded headers on a real socket, and the cache keeps each Host apart', async () => {
    const { site, directory, lines } = await started();
    try {
      const first = await call(site, 'localhost', forged);
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({
        tenant: { organizationId: ORG_A, projectId: PRJ_A },
        siteId: SITE_A,
      });

      const unknown = await call(site, '127.0.0.1', { 'x-forwarded-host': 'localhost' });
      expect(unknown.status).toBe(404);

      // The second request for localhost is answered from the cache, still as tenant A.
      const again = await call(site, 'localhost');
      expect(await again.json()).toMatchObject({ siteId: SITE_A });
      expect(directory.calls).toEqual(['custom:localhost']);
      expect(JSON.stringify(lines)).not.toContain('beta');
    } finally {
      await site.stop();
    }
  });

  it('stops taking connections once stopped', async () => {
    const { site } = await started();
    await site.stop();
    await expect(call(site, 'localhost')).rejects.toThrow();
    await site.stop();
  });

  it('refuses to start on a bad config before it listens', async () => {
    await expect(
      startDocsSite(
        { ...ENV, DREFYN_DOCS_HOST_SUFFIX: 'drefyn.dev' },
        { directory: fakeDirectory(), flags: flagsOnFor().client },
      ),
    ).rejects.toBeInstanceOf(DocsSiteConfigError);
  });

  it('reports a port it cannot take', async () => {
    const { site } = await started();
    try {
      await expect(
        startDocsSite(ENV, {
          directory: fakeDirectory(),
          flags: flagsOnFor().client,
          logger: captureLogger().logger,
          listen: { hostname: '127.0.0.1', port: site.port },
        }),
      ).rejects.toThrow();
    } finally {
      await site.stop();
    }
  });
});

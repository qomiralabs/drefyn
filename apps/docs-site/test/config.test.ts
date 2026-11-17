import { describe, expect, it } from 'vitest';
import { DocsSiteConfigError, parseDocsSiteConfig } from '../src/index.ts';

const BASE = {
  DREFYN_APP_ORIGIN: 'https://app.drefyn.com',
  DREFYN_DOCS_HOST_SUFFIX: 'drefyn.app',
};

const refusal = (env: Record<string, string | undefined>) => {
  try {
    parseDocsSiteConfig(env);
  } catch (error) {
    if (error instanceof DocsSiteConfigError) return { key: error.key, message: error.message };
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('parseDocsSiteConfig', () => {
  it('reads the suffix, the domain it reserves, the dashboard host and the port', () => {
    expect(
      parseDocsSiteConfig({
        ...BASE,
        DREFYN_DOCS_HOST_SUFFIX: 'Docs.Example.Org',
        DREFYN_DOCS_SITE_PORT: '4100',
      }),
    ).toEqual({
      domains: {
        hostSuffix: 'docs.example.org',
        reservedDomain: 'example.org',
        dashboardHost: 'app.drefyn.com',
      },
      port: 4100,
    });
  });

  it('defaults the port to 3002', () => {
    expect(parseDocsSiteConfig(BASE).port).toBe(3002);
  });

  it('defaults the suffix to drefyn.app on the hosted service only', () => {
    expect(
      parseDocsSiteConfig({ DREFYN_APP_ORIGIN: BASE.DREFYN_APP_ORIGIN, DREFYN_HOSTED: 'true' })
        .domains,
    ).toEqual({
      hostSuffix: 'drefyn.app',
      reservedDomain: 'drefyn.app',
      dashboardHost: 'app.drefyn.com',
    });
    expect(refusal({ DREFYN_APP_ORIGIN: BASE.DREFYN_APP_ORIGIN }).key).toBe(
      'DREFYN_DOCS_HOST_SUFFIX',
    );
  });

  it('reserves the suffix itself when it has no parent of its own to reserve', () => {
    expect(parseDocsSiteConfig(BASE).domains.reservedDomain).toBe('drefyn.app');
  });

  it('refuses a dashboard host under the domain the suffix reserves', () => {
    const found = refusal({
      DREFYN_APP_ORIGIN: 'https://app.example.org',
      DREFYN_DOCS_HOST_SUFFIX: 'docs.example.org',
    });
    expect(found.key).toBe('DREFYN_DOCS_HOST_SUFFIX');
  });

  it.each([
    ['equals', 'app.drefyn.com'],
    ['is the parent of', 'drefyn.com'],
    ['sits under', 'docs.app.drefyn.com'],
  ])('refuses a suffix that %s the dashboard host', (_how, suffix) => {
    const found = refusal({ ...BASE, DREFYN_DOCS_HOST_SUFFIX: suffix });
    expect(found.key).toBe('DREFYN_DOCS_HOST_SUFFIX');
    expect(found.message).toContain('dashboard');
  });

  it('compares the dashboard host without its port or case', () => {
    expect(
      refusal({
        ...BASE,
        DREFYN_APP_ORIGIN: 'https://APP.example.org:8443',
        DREFYN_DOCS_HOST_SUFFIX: 'example.org',
      }).key,
    ).toBe('DREFYN_DOCS_HOST_SUFFIX');
  });

  it.each([
    [{ DREFYN_APP_ORIGIN: undefined }, 'DREFYN_APP_ORIGIN'],
    [{ DREFYN_APP_ORIGIN: 'app.drefyn.com' }, 'DREFYN_APP_ORIGIN'],
    [{ DREFYN_APP_ORIGIN: 'ftp://app.drefyn.com' }, 'DREFYN_APP_ORIGIN'],
    [{ DREFYN_APP_ORIGIN: 'https://user@app.drefyn.com' }, 'DREFYN_APP_ORIGIN'],
    [{ DREFYN_APP_ORIGIN: 'https://app.drefyn.com/path' }, 'DREFYN_APP_ORIGIN'],
    [{ DREFYN_APP_ORIGIN: 'https://10.0.0.1' }, 'DREFYN_APP_ORIGIN'],
    [{ DREFYN_DOCS_HOST_SUFFIX: '' }, 'DREFYN_DOCS_HOST_SUFFIX'],
    [{ DREFYN_DOCS_HOST_SUFFIX: 'https://drefyn.app' }, 'DREFYN_DOCS_HOST_SUFFIX'],
    [{ DREFYN_DOCS_HOST_SUFFIX: 'drefyn.app.' }, 'DREFYN_DOCS_HOST_SUFFIX'],
    [{ DREFYN_DOCS_HOST_SUFFIX: '10.0.0.1' }, 'DREFYN_DOCS_HOST_SUFFIX'],
    [{ DREFYN_DOCS_HOST_SUFFIX: 'drefyn.app:443' }, 'DREFYN_DOCS_HOST_SUFFIX'],
    [{ DREFYN_DOCS_HOST_SUFFIX: '*.drefyn.app' }, 'DREFYN_DOCS_HOST_SUFFIX'],
    [{ DREFYN_DOCS_HOST_SUFFIX: 'localhost' }, 'DREFYN_DOCS_HOST_SUFFIX'],
    [{ DREFYN_DOCS_SITE_PORT: '0' }, 'DREFYN_DOCS_SITE_PORT'],
    [{ DREFYN_DOCS_SITE_PORT: '65536' }, 'DREFYN_DOCS_SITE_PORT'],
    [{ DREFYN_DOCS_SITE_PORT: '30.5' }, 'DREFYN_DOCS_SITE_PORT'],
    [{ DREFYN_DOCS_SITE_PORT: 'http' }, 'DREFYN_DOCS_SITE_PORT'],
  ])('refuses %j', (change, key) => {
    expect(refusal({ ...BASE, ...change }).key).toBe(key);
  });

  it('names the key and never echoes the value it refused', () => {
    const found = refusal({ ...BASE, DREFYN_APP_ORIGIN: 'https://secret-host.internal/x' });
    expect(found.message).not.toContain('secret-host');
  });
});

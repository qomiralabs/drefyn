import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REQUEST_PATH_HEADER } from '../src/server/origin.ts';
import { contentSecurityPolicy, NONCE_HEADER } from '../src/server/security-headers.ts';

const SOURCE = readFileSync(new URL('../src/proxy.ts', import.meta.url), 'utf8');

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function run(path: string, init: Record<string, string> = {}) {
  const { proxy } = await import('../src/proxy.ts');
  return proxy(new NextRequest(`http://127.0.0.1:3100${path}`, { headers: init }));
}

const nonceOf = (policy: string | null): string => /'nonce-([^']+)'/.exec(policy ?? '')?.[1] ?? '';

describe('proxy', () => {
  it('sets the policy with a fresh nonce on every response', async () => {
    const first = await run('/acme');
    const second = await run('/acme');
    const a = nonceOf(first.headers.get('content-security-policy'));
    const b = nonceOf(second.headers.get('content-security-policy'));
    expect(a).not.toBe('');
    expect(a).not.toBe(b);
    expect(first.headers.get('content-security-policy')).toBe(contentSecurityPolicy(a));
    expect(first.headers.get('x-content-type-options')).toBe('nosniff');
    expect(first.headers.get('strict-transport-security')).toBeNull();
  });

  it('hands the layout its own nonce, never the one the client sent', async () => {
    const response = await run('/acme', { [NONCE_HEADER]: 'attacker' });
    const nonce = nonceOf(response.headers.get('content-security-policy'));
    expect(response.headers.get(`x-middleware-request-${NONCE_HEADER}`)).toBe(nonce);
    expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(
      contentSecurityPolicy(nonce),
    );
  });

  it('adds HSTS when the configured origin is https', async () => {
    vi.stubEnv('DREFYN_APP_ORIGIN', 'https://app.drefyn.test');
    const response = await run('/acme');
    expect(response.headers.get('strict-transport-security')).toBe(
      'max-age=63072000; includeSubDomains',
    );
  });

  it('uses the path for the referrer policy', async () => {
    expect((await run('/invite')).headers.get('referrer-policy')).toBe('no-referrer');
    expect((await run('/acme')).headers.get('referrer-policy')).toBe(
      'strict-origin-when-cross-origin',
    );
  });

  it('overwrites the request path header, whatever the client sent', async () => {
    const response = await run('/acme/docs?tab=a', { [REQUEST_PATH_HEADER]: '//evil.test' });
    expect(response.headers.get(`x-middleware-request-${REQUEST_PATH_HEADER}`)).toBe(
      '/acme/docs?tab=a',
    );
  });

  it('skips only immutable build output', async () => {
    const { config } = await import('../src/proxy.ts');
    expect(config.matcher).toEqual(['/((?!_next/static/|_next/image).*)']);
  });
});

// Auth decisions live in the guard every page awaits. A proxy that reads a cookie or
// redirects is the shape of the proxy bypass advisories, so it may do neither.
describe('proxy source', () => {
  const code = SOURCE.replace(/\/\/[^\n]*/g, '');

  it('reads no cookie', () => {
    expect(code).not.toMatch(/cookie/i);
  });

  it('makes no redirect or rewrite and never answers on its own', () => {
    expect(code).not.toMatch(/redirect|rewrite|new Response|NextResponse\.json/i);
    expect(code.match(/NextResponse\.\w+/g)).toEqual(['NextResponse.next']);
  });
});

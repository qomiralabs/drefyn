import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  contentSecurityPolicy,
  forwardedRequestHeaders,
  NONCE_HEADER,
  newNonce,
  securityHeaders,
  servedOverHttps,
  withSignOutHeaders,
} from '../src/server/security-headers.ts';

const NONCE = 'AAECAwQFBgcICQoLDA0ODw==';

const build = (pathname: string, https = false, development = false) =>
  securityHeaders({ nonce: NONCE, pathname, https, development });

describe('contentSecurityPolicy', () => {
  it('is the exact policy, with the nonce for scripts and styles', () => {
    expect(contentSecurityPolicy(NONCE)).toBe(
      `default-src 'self'; script-src 'self' 'nonce-${NONCE}' 'strict-dynamic'; ` +
        `style-src 'self' 'nonce-${NONCE}'; frame-ancestors 'none'; form-action 'self'; ` +
        `base-uri 'none'; object-src 'none'`,
    );
  });

  it('never allows inline styles or scripts without the nonce', () => {
    for (const development of [false, true]) {
      const policy = contentSecurityPolicy(NONCE, development);
      expect(policy).not.toContain("'unsafe-inline'");
      const style = policy.split('; ').find((d) => d.startsWith('style-src '));
      expect(style).toBe(`style-src 'self' 'nonce-${NONCE}'`);
    }
  });

  it('allows eval only in next dev, where React needs it for error stacks', () => {
    expect(contentSecurityPolicy(NONCE)).not.toContain("'unsafe-eval'");
    expect(contentSecurityPolicy(NONCE, true)).toContain(
      `script-src 'self' 'nonce-${NONCE}' 'strict-dynamic' 'unsafe-eval';`,
    );
  });

  it('refuses a nonce that could break out of the header', () => {
    for (const bad of ['', "abc' 'unsafe-inline", 'a b', 'abc;script-src *', 'abc\r\nx: y']) {
      expect(() => contentSecurityPolicy(bad)).toThrow(/nonce/);
    }
  });
});

describe('newNonce', () => {
  it('is 16 random bytes in base64, different every call', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const nonce = newNonce();
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      seen.add(nonce);
    }
    expect(seen.size).toBe(200);
  });

  it('always makes a policy that carries it twice and nothing else', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 16, maxLength: 16 }), (bytes) => {
        const nonce = Buffer.from(bytes).toString('base64');
        const policy = contentSecurityPolicy(nonce);
        expect(policy.split(`'nonce-${nonce}'`)).toHaveLength(3);
        expect(policy.replaceAll(nonce, 'N')).toBe(contentSecurityPolicy('N'));
      }),
    );
  });
});

describe('securityHeaders', () => {
  it('sends every header with its exact value on a dashboard route over http', () => {
    expect(build('/acme/docs/payments-api')).toEqual({
      'Content-Security-Policy': contentSecurityPolicy(NONCE),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Cache-Control': 'no-store',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    });
  });

  it('adds HSTS only when the app origin is https, and never asks for preload', () => {
    expect(build('/acme')).not.toHaveProperty('Strict-Transport-Security');
    expect(build('/acme', true)['Strict-Transport-Security']).toBe(
      'max-age=63072000; includeSubDomains',
    );
  });

  it('sends no referrer from the verify and invitation pages, whose links carry secrets', () => {
    for (const path of ['/sign-in/verify', '/invite', '/invite/block']) {
      expect(build(path)['Referrer-Policy'], path).toBe('no-referrer');
    }
  });

  it('keeps the default referrer policy everywhere else, including near misses', () => {
    for (const path of [
      '/',
      '/sign-in',
      '/sign-in/verifyx',
      '/sign-in/verify-old',
      '/invites',
      '/invitex/block',
      '/acme/invite',
      '/acme/sign-in/verify',
    ]) {
      expect(build(path)['Referrer-Policy'], path).toBe('strict-origin-when-cross-origin');
    }
  });
});

describe('forwardedRequestHeaders', () => {
  it('always overwrites a client supplied nonce and policy', () => {
    const incoming = new Headers({
      [NONCE_HEADER]: 'attacker',
      'content-security-policy': "script-src 'nonce-attacker'",
      accept: 'text/html',
    });
    const forwarded = forwardedRequestHeaders(incoming, NONCE, contentSecurityPolicy(NONCE));
    expect(forwarded.get(NONCE_HEADER)).toBe(NONCE);
    expect(forwarded.get('content-security-policy')).toBe(contentSecurityPolicy(NONCE));
    expect(forwarded.get('accept')).toBe('text/html');
    expect(incoming.get(NONCE_HEADER)).toBe('attacker');
  });
});

describe('servedOverHttps', () => {
  it('is true only for an https app origin', () => {
    expect(servedOverHttps({ DREFYN_APP_ORIGIN: 'https://app.drefyn.test' })).toBe(true);
    expect(servedOverHttps({ DREFYN_APP_ORIGIN: 'https://127.0.0.1:8443' })).toBe(true);
    expect(servedOverHttps({ DREFYN_APP_ORIGIN: 'http://127.0.0.1:3100' })).toBe(false);
    expect(servedOverHttps({ DREFYN_APP_ORIGIN: 'http://localhost:3000' })).toBe(false);
  });

  it('is false when no origin is configured, as on a loopback dev or test server', () => {
    expect(servedOverHttps({})).toBe(false);
    expect(servedOverHttps({ DREFYN_APP_ORIGIN: '' })).toBe(false);
  });

  it('refuses a value that is not an http or https URL', () => {
    for (const value of ['app.drefyn.test', 'ftp://app.drefyn.test', 'javascript:alert(1)']) {
      expect(() => servedOverHttps({ DREFYN_APP_ORIGIN: value }), value).toThrow(
        /DREFYN_APP_ORIGIN/,
      );
    }
  });
});

describe('withSignOutHeaders', () => {
  // Stands in for the sign out route until it lands: it ends the session and goes to sign in.
  const signOut = (): Response =>
    withSignOutHeaders(new Response(null, { status: 303, headers: { location: '/sign-in' } }));

  it('tells the browser to drop every cookie for the origin and not to cache the answer', () => {
    const response = signOut();
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/sign-in');
    expect(response.headers.get('Clear-Site-Data')).toBe('"cookies"');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('the sign in link pages', () => {
  it.each(['/sign-in/verify', '/sign-in/cli', '/invite', '/invite/block'])(
    '%s sends no referrer, since its link carries a secret',
    (pathname) => {
      const headers = securityHeaders({ nonce: 'abc', pathname, https: true, development: false });
      expect(headers['Referrer-Policy']).toBe('no-referrer');
      expect(headers['Cache-Control']).toBe('no-store');
    },
  );
});

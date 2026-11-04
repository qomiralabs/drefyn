import fc from 'fast-check';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appOrigin,
  appUrl,
  originAllowed,
  REQUEST_PATH_HEADER,
  requestPath,
} from '../src/server/origin.ts';

const ORIGIN = 'https://app.drefyn.test';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('appOrigin', () => {
  it('reads the configured origin', () => {
    vi.stubEnv('DREFYN_APP_ORIGIN', ORIGIN);
    expect(appOrigin()).toBe(ORIGIN);
  });

  it.each([
    '',
    'not a url',
    'ftp://app.drefyn.test',
    `${ORIGIN}/path`,
    `${ORIGIN}/`,
    `${ORIGIN}?a=1`,
  ])('throws on %j rather than guessing', (value) => {
    vi.stubEnv('DREFYN_APP_ORIGIN', value);
    expect(() => appOrigin()).toThrow('DREFYN_APP_ORIGIN');
  });

  it('never echoes the value it refused', () => {
    vi.stubEnv('DREFYN_APP_ORIGIN', 'https://user:hunter2@app.drefyn.test');
    expect(() => appOrigin()).toThrow(/^(?!.*hunter2)/);
  });
});

describe('appUrl', () => {
  it('builds an absolute URL from the configured origin', () => {
    vi.stubEnv('DREFYN_APP_ORIGIN', ORIGIN);
    expect(appUrl('/sign-in?next=%2Facme').href).toBe(`${ORIGIN}/sign-in?next=%2Facme`);
    expect(appUrl('/').href).toBe(`${ORIGIN}/`);
  });

  it.each([
    '//evil.test',
    '/\\evil.test',
    '\\\\evil.test',
    'https://evil.test',
    '/\tevil',
    '/a\nb',
    'javascript:alert(1)',
    '',
    '/x/..//evil.test',
  ])('refuses %j', (path) => {
    vi.stubEnv('DREFYN_APP_ORIGIN', ORIGIN);
    expect(() => appUrl(path)).toThrow(RangeError);
  });

  it('never leaves the origin for any input', () => {
    vi.stubEnv('DREFYN_APP_ORIGIN', ORIGIN);
    const hostile = fc.oneof(
      fc.string(),
      fc.webUrl(),
      fc.webPath(),
      fc
        .array(fc.constantFrom('/', '\\', '.', '..', '//', '@', ':', '%2f', '\t', 'evil.test'), {
          maxLength: 8,
        })
        .map((parts) => parts.join('')),
    );
    fc.assert(
      fc.property(hostile, (path) => {
        try {
          expect(appUrl(path).origin).toBe(ORIGIN);
        } catch (error) {
          expect(error).toBeInstanceOf(RangeError);
        }
      }),
    );
  });
});

describe('requestPath', () => {
  it('keeps the pathname and search only, whatever host the request names', () => {
    const request = new NextRequest('http://internal:3000/acme/docs?tab=a#frag', {
      headers: { host: 'evil.test', 'x-forwarded-host': 'evil.test' },
    });
    expect(requestPath(request)).toBe('/acme/docs?tab=a');
  });

  it('names the private header', () => {
    expect(REQUEST_PATH_HEADER).toBe('x-drefyn-request-path');
  });
});

describe('originAllowed', () => {
  const allowed = (init: Record<string, string>) => originAllowed(new Headers(init), ORIGIN);

  it('takes the exact origin, with or without Sec-Fetch-Site', () => {
    expect(allowed({ origin: ORIGIN })).toBe(true);
    expect(allowed({ origin: ORIGIN, 'sec-fetch-site': 'same-origin' })).toBe(true);
  });

  it.each([
    [{}],
    [{ origin: 'null' }],
    [{ origin: 'https://evil.test' }],
    [{ origin: `${ORIGIN}.evil.test` }],
    [{ origin: 'http://app.drefyn.test' }],
    [{ origin: `${ORIGIN}/` }],
    [{ origin: ORIGIN, 'sec-fetch-site': 'cross-site' }],
    [{ origin: ORIGIN, 'sec-fetch-site': 'same-site' }],
    [{ origin: ORIGIN, 'sec-fetch-site': 'none' }],
    [{ origin: ORIGIN, 'sec-fetch-site': '' }],
  ])('refuses %j', (init: Record<string, string>) => {
    expect(allowed(init)).toBe(false);
  });
});

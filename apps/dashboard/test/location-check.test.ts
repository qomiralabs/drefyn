import { describe, expect, it } from 'vitest';
import { absoluteLinkProblems, locationProblem, providerHandover } from '../e2e/location-check.ts';

const ORIGIN = 'http://127.0.0.1:3100';

describe('the Location check', () => {
  it.each(['/sign-in?next=%2Facme', '/acme', 'relative', `${ORIGIN}/acme`, ORIGIN])(
    'accepts %s',
    (value) => {
      expect(locationProblem(value, ORIGIN)).toBeNull();
    },
  );

  it.each([
    'http://evil.test/',
    '//evil.test/',
    '/\\evil.test',
    `${ORIGIN}.evil.test/`,
    `${ORIGIN}@evil.test/`,
    'http://localhost:3000/acme',
    'http://127.0.0.1:3000/acme',
  ])('refuses %s', (value) => {
    expect(locationProblem(value, ORIGIN)).toBe(value);
  });
});

describe('the absolute link check', () => {
  it('finds a link off the origin, in any attribute that navigates', () => {
    const html = `<a href="http://evil.test/a">x</a><form action='//evil.test/b'></form>
      <link rel="canonical" href="http://localhost:3000/c">`;
    expect(absoluteLinkProblems(html, ORIGIN)).toEqual([
      'http://evil.test/a',
      '//evil.test/b',
      'http://localhost:3000/c',
    ]);
  });

  it('reads unquoted attributes and a scheme with no slashes', () => {
    expect(absoluteLinkProblems('<a href=http://evil.test/a>x</a>', ORIGIN)).toEqual([
      'http://evil.test/a',
    ]);
    expect(absoluteLinkProblems('<a href="https:evil.test">x</a>', ORIGIN)).toEqual([
      'https:evil.test',
    ]);
    expect(locationProblem('https:evil.test', ORIGIN)).toBe('https:evil.test');
  });

  it('allows our own status page link by exact value, in a link only', () => {
    expect(absoluteLinkProblems('<a href="https://status.drefyn.com">s</a>', ORIGIN)).toEqual([]);
    for (const link of [
      'https://status.drefyn.com/x',
      'https://status.drefyn.com.evil.test',
      'http://status.drefyn.com',
    ]) {
      expect(absoluteLinkProblems(`<a href="${link}">s</a>`, ORIGIN)).toEqual([link]);
    }
    expect(locationProblem('https://status.drefyn.com', ORIGIN)).toBe('https://status.drefyn.com');
  });

  it('passes relative links, own origin links, fragments and known outside hosts', () => {
    const html = `<a href="/acme">x</a><a href="#main">y</a><a href="${ORIGIN}/z">z</a>
      <a href="mailto:a@b.c">m</a><svg xmlns="http://www.w3.org/2000/svg"></svg>`;
    expect(absoluteLinkProblems(html, ORIGIN)).toEqual([]);
  });
});

describe('the OAuth handover', () => {
  const start = (provider: string) => `${ORIGIN}/auth/oauth/${provider}/start?next=%2Facme`;
  const GITHUB = 'https://github.com/login/oauth/authorize?client_id=x&state=y';
  const GOOGLE = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x';

  it('lets each start route send a browser to its own provider', () => {
    expect(providerHandover(start('github'), GITHUB)).toBe(true);
    expect(providerHandover(start('google'), GOOGLE)).toBe(true);
  });

  it.each([
    ['the other provider', start('github'), GOOGLE],
    ['another route', `${ORIGIN}/auth/oauth/github/callback`, GITHUB],
    ['a page', `${ORIGIN}/sign-in`, GITHUB],
    ['a look alike host', start('github'), 'https://github.com.evil.test/login/oauth/authorize'],
    ['another path', start('github'), 'https://github.com/login/oauth/authorize/x'],
    ['http', start('github'), 'http://github.com/login/oauth/authorize'],
    ['a user part', start('github'), 'https://github.com@evil.test/login/oauth/authorize'],
    ['a relative target', start('github'), '/login/oauth/authorize'],
    ['nonsense', start('github'), 'not a url'],
  ])('refuses %s', (_name, url, location) => {
    expect(providerHandover(url, location)).toBe(false);
  });
});

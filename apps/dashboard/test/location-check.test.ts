import { describe, expect, it } from 'vitest';
import { absoluteLinkProblems, locationProblem } from '../e2e/location-check.ts';

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

  it('passes relative links, own origin links, fragments and known outside hosts', () => {
    const html = `<a href="/acme">x</a><a href="#main">y</a><a href="${ORIGIN}/z">z</a>
      <a href="mailto:a@b.c">m</a><svg xmlns="http://www.w3.org/2000/svg"></svg>`;
    expect(absoluteLinkProblems(html, ORIGIN)).toEqual([]);
  });
});

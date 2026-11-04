import { describe, expect, it } from 'vitest';
import { preRedirect, preTarget } from '../src/auth/pre-target.ts';

describe('preTarget', () => {
  it.each([
    '/sign-in',
    '/sign-up',
    '/sign-in/verify',
    '/sign-in/password',
    '/sign-in/reset',
    '/sign-in/link',
    '/sign-in/cli',
    '/invite',
    '/invite/block',
  ])('takes %s', (path) => {
    expect(preTarget(path)).toBe(path);
  });

  it('keeps a query, which holds no secret', () => {
    expect(preTarget('/sign-in?next=%2Facme')).toBe('/sign-in?next=%2Facme');
  });

  it.each([
    'https://evil.example/sign-in',
    '//evil.example/sign-in',
    '/sign-in/../acme',
    '/acme',
    '/',
    '',
    null,
    '/sign-in\\evil',
    '/sign-in#fragment',
  ])('sends %s to sign in', (path) => {
    expect(preTarget(path)).toBe('/sign-in');
  });
});

describe('preRedirect', () => {
  it('asks the mint route to come back to the page', () => {
    expect(preRedirect('/sign-in/verify')).toBe('/auth/pre?to=%2Fsign-in%2Fverify');
  });
});

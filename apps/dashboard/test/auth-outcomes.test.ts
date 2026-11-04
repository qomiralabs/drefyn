import { AuthError } from '@drefyn/auth';
import { describe, expect, it } from 'vitest';
import {
  minutesLeft,
  noticeFor,
  oauthNotice,
  refusalNotice,
  signInMethods,
} from '../src/auth/outcomes.ts';

describe('minutesLeft', () => {
  it.each([
    [undefined, 1],
    [0, 1],
    [1, 1],
    [60, 1],
    [61, 2],
    [840, 14],
  ])('%s seconds reads as %i minutes', (seconds, minutes) => {
    expect(minutesLeft(seconds)).toBe(minutes);
  });
});

describe('noticeFor', () => {
  it('turns a limit into minutes and keeps the reference out of it', () => {
    const error = new AuthError('AUTH_RATE_LIMITED', { retryAfterSeconds: 840 });
    expect(noticeFor(error, 'ref_1')).toEqual({ kind: 'limited', minutes: 14 });
  });

  it('gives the person a reference for our own failure', () => {
    expect(noticeFor(new AuthError('AUTH_UNAVAILABLE'), 'ref_1')).toEqual({
      kind: 'unavailable',
      reference: 'ref_1',
    });
  });

  it('reads a failed bot check as paused, never as a wrong answer', () => {
    expect(noticeFor(new AuthError('AUTH_BOT_CHECK_REQUIRED'), 'ref_1')).toEqual({
      kind: 'botcheck_down',
    });
  });

  it('treats an unplanned code as our failure, so no raw code reaches a page', () => {
    expect(noticeFor(new AuthError('AUTH_NOT_FOUND'), 'ref_1')).toEqual({
      kind: 'unavailable',
      reference: 'ref_1',
    });
  });
});

describe('refusalNotice', () => {
  it('reads a stale binding as a page left open', () => {
    expect(refusalNotice({ ok: false, status: 403, code: 'auth.challenge_binding' }, 'r')).toEqual({
      kind: 'expired',
    });
  });

  it.each([
    [403, 'auth.origin_refused'],
    [503, 'auth.client_ip_unresolved'],
    [413, 'auth.body_too_large'],
    [400, 'auth.input_invalid'],
  ] as const)('reads %i %s as our failure', (status, code) => {
    expect(refusalNotice({ ok: false, status, code }, 'r')).toEqual({
      kind: 'unavailable',
      reference: 'r',
    });
  });
});

describe('oauthNotice', () => {
  it.each([
    ['provider', 'github', { kind: 'oauth_error', provider: 'GitHub' }],
    ['state', 'google', { kind: 'oauth_error', provider: 'Google' }],
    ['unverified', 'github', { kind: 'oauth_unverified', provider: 'GitHub' }],
    ['closed', 'google', { kind: 'oauth_closed', provider: 'Google' }],
  ])('%s from %s', (error, provider, notice) => {
    expect(oauthNotice(error, provider)).toEqual(notice);
  });

  it.each([
    ['nonsense', 'github'],
    ['provider', 'gitlab'],
    [undefined, 'github'],
    ['provider', undefined],
    [['provider', 'state'], 'github'],
  ])('shows nothing for %s from %s, so a link cannot write on the page', (error, provider) => {
    expect(oauthNotice(error, provider)).toBeNull();
  });
});

describe('signInMethods', () => {
  const client = { clientId: 'id' };
  const base = {
    email: 'auto',
    oauth: { github: null, google: null },
    passwords: { enabled: true },
  } as const;

  it('offers email only with a working transport under auto', () => {
    expect(signInMethods(base, true).email).toBe(true);
    expect(signInMethods(base, false).email).toBe(false);
  });

  it('honours an explicit off', () => {
    expect(signInMethods({ ...base, email: 'off' }, true).email).toBe(false);
  });

  it('never claims email on with no transport', () => {
    expect(signInMethods({ ...base, email: 'on' }, false).email).toBe(false);
  });

  it('lists configured providers in the order they are shown', () => {
    const methods = signInMethods({ ...base, oauth: { github: client, google: client } }, true);
    expect(methods.providers).toEqual(['github', 'google']);
    expect(signInMethods(base, true).providers).toEqual([]);
  });

  it('counts a server with neither email nor a provider as not set up, passwords or not', () => {
    expect(signInMethods(base, false).setUp).toBe(false);
    expect(signInMethods(base, true).setUp).toBe(true);
    expect(signInMethods({ ...base, oauth: { github: client, google: null } }, false).setUp).toBe(
      true,
    );
  });
});

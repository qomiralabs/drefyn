import { after } from 'next/server';
import type * as NextServer from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://app.drefyn.test';
const completeOAuth = vi.fn();
const arrival = vi.fn<(s: unknown, to: string) => Promise<string>>();
const SESSION = { email: 'a@example.com' };
const COOKIES = { session: '__Host-drefyn_session', oauth: '__Host-drefyn_oauth' };
const visitorBrowser = vi.fn<() => Promise<unknown>>();
const guardPublic = vi.fn<() => Promise<void>>();

vi.mock('../src/server/auth.ts', () => ({
  dashboardAuth: () => Promise.resolve({ oauth: { completeOAuth } }),
  authConfig: () => ({ cookieSecure: true, cookies: COOKIES }),
}));
vi.mock('../src/server/actions.ts', () => ({ visitorBrowser }));
vi.mock('../src/server/guard.ts', () => ({ guardPublic }));
vi.mock('../src/server/first-run.ts', () => ({ arrival }));
vi.mock('../src/server/origin.ts', () => ({
  appOrigin: () => ORIGIN,
  appUrl: (path: string) => new URL(path, ORIGIN),
  requestQuery: () => new URLSearchParams(),
}));
vi.mock('next/server', async (original) => ({
  ...(await original<typeof NextServer>()),
  after: vi.fn(),
}));

const { GET } = await import('../src/app/auth/oauth/[provider]/callback/route.ts');

const call = (provider = 'github') =>
  GET({ headers: new Headers() } as never, { params: Promise.resolve({ provider }) });

const SESSION_COOKIE = {
  name: COOKIES.session,
  value: 'secret',
  maxAgeSeconds: 2_592_000,
};
const refused = (code: string) => completeOAuth.mockResolvedValue({ ok: false, error: { code } });

beforeEach(() => {
  vi.clearAllMocks();
  guardPublic.mockResolvedValue();
  visitorBrowser.mockResolvedValue({ ip: '203.0.113.9' });
  arrival.mockResolvedValue('/welcome?next=%2Facme');
});

describe('the OAuth callback', () => {
  it('sends a sign in through arrival, so a new person meets Welcome first', async () => {
    completeOAuth.mockResolvedValue({
      ok: true,
      value: { kind: 'signed_in', session: SESSION, setCookies: [], returnTo: '/acme' },
    });
    const response = await call();
    expect(arrival).toHaveBeenCalledWith(SESSION, '/acme');
    expect(response.headers.get('location')).toBe(`${ORIGIN}/welcome?next=%2Facme`);
  });

  it('leaves a step up where it was going', async () => {
    completeOAuth.mockResolvedValue({
      ok: true,
      value: { kind: 'stepped_up', session: SESSION, setCookies: [], returnTo: '/account' },
    });
    const response = await call();
    expect(arrival).not.toHaveBeenCalled();
    expect(response.headers.get('location')).toBe(`${ORIGIN}/account`);
  });

  it('keeps a step up on this origin, whatever return path the row held', async () => {
    completeOAuth.mockResolvedValue({
      ok: true,
      value: {
        kind: 'stepped_up',
        session: SESSION,
        setCookies: [],
        returnTo: 'https://evil.test/x',
      },
    });
    const response = await call();
    expect(response.headers.get('location')).toBe(`${ORIGIN}/`);
  });

  it('sets the session cookie on a sign in', async () => {
    completeOAuth.mockResolvedValue({
      ok: true,
      value: {
        kind: 'signed_in',
        session: SESSION,
        setCookies: [SESSION_COOKIE],
        returnTo: '/',
      },
    });
    const response = await call();
    expect(response.status).toBe(303);
    expect(response.headers.getSetCookie()).toEqual([
      '__Host-drefyn_session=secret; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax',
    ]);
  });

  it('owes no mail on a sign in with nothing to send', async () => {
    completeOAuth.mockResolvedValue({
      ok: true,
      value: { kind: 'signed_in', session: SESSION, setCookies: [], returnTo: '/' },
    });
    await call();
    expect(after).not.toHaveBeenCalled();
  });

  it('sends the new device notice after the response', async () => {
    const send = vi.fn();
    completeOAuth.mockResolvedValue({
      ok: true,
      value: { kind: 'signed_in', session: SESSION, setCookies: [], returnTo: '/', send },
    });
    await call();
    expect(after).toHaveBeenCalledExactlyOnceWith(send);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends a verified match to the link page, signed out, with the code owed', async () => {
    const send = vi.fn();
    completeOAuth.mockResolvedValue({
      ok: true,
      value: {
        kind: 'link_pending',
        setCookies: [{ name: COOKIES.oauth, value: '', maxAgeSeconds: 0 }],
        send,
      },
    });
    const response = await call('google');
    expect(response.headers.get('location')).toBe(`${ORIGIN}/sign-in/link`);
    expect(response.headers.getSetCookie()).toEqual([
      '__Host-drefyn_oauth=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
    ]);
    expect(after).toHaveBeenCalledExactlyOnceWith(send);
    expect(arrival).not.toHaveBeenCalled();
  });

  it.each([
    ['AUTH_OAUTH_STATE_INVALID', 'state'],
    ['AUTH_OAUTH_EMAIL_UNVERIFIED', 'unverified'],
    ['AUTH_SIGNUP_CLOSED', 'closed'],
    ['AUTH_OAUTH_PROVIDER_ERROR', 'provider'],
    ['AUTH_OAUTH_DISABLED', 'provider'],
    ['AUTH_UNAVAILABLE', 'provider'],
    ['AUTH_INPUT_INVALID', 'provider'],
  ])('sends %s back to sign in as %s, with no cookies', async (code, name) => {
    refused(code);
    const response = await call('google');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      `${ORIGIN}/sign-in?error=${name}&provider=google`,
    );
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(arrival).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it('sends a browser it cannot read back to sign in without asking auth', async () => {
    visitorBrowser.mockResolvedValue(null);
    const response = await call();
    expect(response.headers.get('location')).toBe(
      `${ORIGIN}/sign-in?error=provider&provider=github`,
    );
    expect(completeOAuth).not.toHaveBeenCalled();
  });

  it.each(['gitlab', '', 'GitHub', '__proto__'])(
    'answers %j with a 404 and completes nothing',
    async (provider) => {
      const response = await call(provider);
      expect(response.status).toBe(404);
      expect(completeOAuth).not.toHaveBeenCalled();
    },
  );

  it('answers for the release flag before anything else', async () => {
    guardPublic.mockRejectedValue(new Error('NEXT_HTTP_ERROR_FALLBACK;404'));
    await expect(call()).rejects.toThrow('404');
    expect(visitorBrowser).not.toHaveBeenCalled();
    expect(completeOAuth).not.toHaveBeenCalled();
  });
});

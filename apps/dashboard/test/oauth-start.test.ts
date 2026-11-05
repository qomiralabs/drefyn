import type * as Origin from '../src/server/origin.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://app.drefyn.test';
const COOKIES = { pre: '__Host-drefyn_pre', oauth: '__Host-drefyn_oauth' };
const BROWSER = { ip: '203.0.113.9' };
const SESSION = { email: 'a@example.com' };
const startOAuth = vi.fn();
const currentSession = vi.fn();
const visitorBrowser = vi.fn<() => Promise<unknown>>();
const guardPublic = vi.fn<() => Promise<void>>();
let query = new URLSearchParams();

vi.mock('../src/server/auth.ts', () => ({
  dashboardAuth: () => Promise.resolve({ oauth: { startOAuth } }),
  authConfig: () => ({ cookieSecure: true, cookies: COOKIES }),
}));
vi.mock('../src/server/actions.ts', () => ({ visitorBrowser }));
vi.mock('../src/server/guard.ts', () => ({ guardPublic, currentSession }));
vi.mock('../src/server/origin.ts', async (original) => ({
  ...(await original<typeof Origin>()),
  appOrigin: () => ORIGIN,
  appUrl: (path: string) => new URL(path, ORIGIN),
  requestQuery: () => query,
}));

const { GET } = await import('../src/app/auth/oauth/[provider]/start/route.ts');

const call = (provider: string, site?: string) => {
  const headers = new Headers(site === undefined ? {} : { 'sec-fetch-site': site });
  return GET({ headers } as never, { params: Promise.resolve({ provider }) });
};

const callFor = (purpose: string | null, site?: string) => {
  query = new URLSearchParams(purpose === null ? {} : { purpose });
  return call('github', site);
};

const refusal = (provider: string) => `${ORIGIN}/sign-in?error=provider&provider=${provider}`;
const METHODS = `${ORIGIN}/account/sign-in?error=provider`;

beforeEach(() => {
  vi.clearAllMocks();
  query = new URLSearchParams();
  guardPublic.mockResolvedValue();
  visitorBrowser.mockResolvedValue(BROWSER);
  currentSession.mockResolvedValue(SESSION);
  startOAuth.mockResolvedValue({
    ok: true,
    value: {
      redirectTo: new URL('https://github.com/login/oauth/authorize?state=abc'),
      setCookies: [
        { name: COOKIES.pre, value: 'p', maxAgeSeconds: 900 },
        { name: COOKIES.oauth, value: 's', maxAgeSeconds: 600 },
      ],
    },
  });
});

describe('the OAuth start route', () => {
  it.each(['github', 'google'])('hands %s the browser and starts a sign in', async (provider) => {
    await call(provider);
    expect(startOAuth).toHaveBeenCalledExactlyOnceWith(BROWSER, { provider, purpose: 'sign_in' });
  });

  it('goes to the provider with a 302', async () => {
    const response = await call('github');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://github.com/login/oauth/authorize?state=abc',
    );
  });

  it('sets both cookies, each with the flags auth decides', async () => {
    const response = await call('github');
    expect(response.headers.getSetCookie()).toEqual([
      '__Host-drefyn_pre=p; Path=/; Max-Age=900; HttpOnly; Secure; SameSite=Lax',
      '__Host-drefyn_oauth=s; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax',
    ]);
  });

  it('passes the return path on, for auth to judge', async () => {
    query = new URLSearchParams({ next: 'https://evil.test' });
    await call('google');
    expect(startOAuth).toHaveBeenCalledExactlyOnceWith(BROWSER, {
      provider: 'google',
      purpose: 'sign_in',
      returnTo: 'https://evil.test',
    });
  });

  it.each(['gitlab', '', 'GitHub', 'github/../google', '__proto__'])(
    'answers %j with a 404 and starts nothing',
    async (provider) => {
      const response = await call(provider);
      expect(response.status).toBe(404);
      expect(startOAuth).not.toHaveBeenCalled();
    },
  );

  it('sends a browser it cannot read back to sign in', async () => {
    visitorBrowser.mockResolvedValue(null);
    const response = await call('google');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(refusal('google'));
    expect(startOAuth).not.toHaveBeenCalled();
  });

  it('sends a refused start back to sign in with no cookies', async () => {
    startOAuth.mockResolvedValue({ ok: false, error: { code: 'AUTH_RATE_LIMITED' } });
    const response = await call('github');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(refusal('github'));
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('answers for the release flag before anything else', async () => {
    guardPublic.mockRejectedValue(new Error('NEXT_HTTP_ERROR_FALLBACK;404'));
    await expect(call('github')).rejects.toThrow('404');
    expect(visitorBrowser).not.toHaveBeenCalled();
    expect(startOAuth).not.toHaveBeenCalled();
  });
});

describe('starting OAuth', () => {
  describe.each(['link', 'step_up'])('for %s', (purpose) => {
    it.each(['cross-site', 'same-site', 'none', undefined])(
      'refuses a navigation from %s, before reading the session',
      async (site) => {
        const response = await callFor(purpose, site);
        expect(startOAuth).not.toHaveBeenCalled();
        expect(currentSession).not.toHaveBeenCalled();
        expect(response.headers.get('location')).toBe(METHODS);
      },
    );

    it('starts from a press on our own page', async () => {
      await callFor(purpose, 'same-origin');
      expect(startOAuth).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ purpose, session: SESSION }),
      );
    });

    it('refuses with nobody signed in', async () => {
      currentSession.mockResolvedValue(null);
      const response = await callFor(purpose, 'same-origin');
      expect(startOAuth).not.toHaveBeenCalled();
      expect(response.headers.get('location')).toBe(refusal('github'));
    });

    it('sends a refused start back to the methods page with no cookies', async () => {
      startOAuth.mockResolvedValue({ ok: false, error: { code: 'AUTH_FORBIDDEN' } });
      const response = await callFor(purpose, 'same-origin');
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe(METHODS);
      expect(response.headers.getSetCookie()).toEqual([]);
    });
  });

  it('still lets a plain sign in arrive from anywhere', async () => {
    await callFor(null, 'cross-site');
    expect(startOAuth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ purpose: 'sign_in' }),
    );
  });

  it('never honours an unknown purpose as anything but sign in', async () => {
    await callFor('admin', 'cross-site');
    expect(startOAuth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ purpose: 'sign_in' }),
    );
  });
});

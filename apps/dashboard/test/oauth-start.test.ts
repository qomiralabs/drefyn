import type * as Origin from '../src/server/origin.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://app.drefyn.test';
const startOAuth = vi.fn();
const currentSession = vi.fn();
const SESSION = { email: 'a@example.com' };
let query = new URLSearchParams();

vi.mock('../src/server/auth.ts', () => ({
  dashboardAuth: () => Promise.resolve({ oauth: { startOAuth } }),
  authConfig: () => ({ cookieSecure: true, cookies: {} }),
}));
vi.mock('../src/server/actions.ts', () => ({
  visitorBrowser: () => Promise.resolve({ ip: '203.0.113.9' }),
}));
vi.mock('../src/server/guard.ts', () => ({
  guardPublic: () => Promise.resolve(),
  currentSession,
}));
vi.mock('../src/server/origin.ts', async (original) => ({
  ...(await original<typeof Origin>()),
  appOrigin: () => ORIGIN,
  appUrl: (path: string) => new URL(path, ORIGIN),
  requestQuery: () => query,
}));

const { GET } = await import('../src/app/auth/oauth/[provider]/start/route.ts');

const call = (purpose: string | null, site?: string) => {
  query = new URLSearchParams(purpose === null ? {} : { purpose });
  const headers = new Headers(site === undefined ? {} : { 'sec-fetch-site': site });
  return GET({ headers } as never, { params: Promise.resolve({ provider: 'github' }) });
};

beforeEach(() => {
  vi.clearAllMocks();
  currentSession.mockResolvedValue(SESSION);
  startOAuth.mockResolvedValue({
    ok: true,
    value: { redirectTo: new URL('https://github.test/authorize'), setCookies: [] },
  });
});

describe('starting OAuth', () => {
  describe.each(['link', 'step_up'])('for %s', (purpose) => {
    it.each(['cross-site', 'same-site', 'none', undefined])(
      'refuses a navigation from %s, before reading the session',
      async (site) => {
        const response = await call(purpose, site);
        expect(startOAuth).not.toHaveBeenCalled();
        expect(currentSession).not.toHaveBeenCalled();
        expect(response.headers.get('location')).toBe(`${ORIGIN}/account/sign-in?error=provider`);
      },
    );

    it('starts from a press on our own page', async () => {
      await call(purpose, 'same-origin');
      expect(startOAuth).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ purpose, session: SESSION }),
      );
    });

    it('refuses with nobody signed in', async () => {
      currentSession.mockResolvedValue(null);
      await call(purpose, 'same-origin');
      expect(startOAuth).not.toHaveBeenCalled();
    });
  });

  it('still lets a plain sign in arrive from anywhere', async () => {
    await call(null, 'cross-site');
    expect(startOAuth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ purpose: 'sign_in' }),
    );
  });

  it('never honours an unknown purpose as anything but sign in', async () => {
    await call('admin', 'cross-site');
    expect(startOAuth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ purpose: 'sign_in' }),
    );
  });
});

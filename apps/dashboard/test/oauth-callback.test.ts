import type * as NextServer from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://app.drefyn.test';
const completeOAuth = vi.fn();
const arrival = vi.fn<(s: unknown, to: string) => Promise<string>>();
const SESSION = { email: 'a@example.com' };

vi.mock('../src/server/auth.ts', () => ({
  dashboardAuth: () => Promise.resolve({ oauth: { completeOAuth } }),
  authConfig: () => ({ cookieSecure: true, cookies: {} }),
}));
vi.mock('../src/server/actions.ts', () => ({
  visitorBrowser: () => Promise.resolve({ ip: '203.0.113.9' }),
}));
vi.mock('../src/server/guard.ts', () => ({ guardPublic: () => Promise.resolve() }));
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

const call = () =>
  GET({ headers: new Headers() } as never, {
    params: Promise.resolve({ provider: 'github' }),
  });

beforeEach(() => {
  vi.clearAllMocks();
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
});

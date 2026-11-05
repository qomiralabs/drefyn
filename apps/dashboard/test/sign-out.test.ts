import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://app.drefyn.test';
const COOKIES = { session: '__Host-drefyn_session' };
const SESSION = { sessionId: 'ses_1', userId: 'usr_1' };
const signOut = vi.fn<(session: unknown) => Promise<readonly unknown[]>>();

vi.mock('../src/server/auth.ts', () => ({
  dashboardAuth: () => Promise.resolve({ sessions: { signOut } }),
  authConfig: () => ({ cookieSecure: true, cookies: COOKIES }),
}));
// The Origin check and the session read have their own tests. Here the handler is what counts.
vi.mock('../src/server/actions.ts', () => ({
  signedInRoute:
    (handler: (context: { session: unknown }) => Promise<Response>) => (): Promise<Response> =>
      handler({ session: SESSION }),
}));
vi.mock('../src/server/origin.ts', () => ({
  appUrl: (path: string) => new URL(path, ORIGIN),
}));

const { POST } = await import('../src/app/sign-out/route.ts');
const call = () => (POST as unknown as () => Promise<Response>)();

beforeEach(() => {
  signOut.mockReset();
  signOut.mockResolvedValue([{ name: COOKIES.session, value: '', maxAgeSeconds: 0 }]);
});

describe('POST /sign-out', () => {
  it('tells the browser to drop every cookie for the site', async () => {
    const response = await call();
    expect(response.headers.get('clear-site-data')).toBe('"cookies"');
  });

  it('is never cached', async () => {
    const response = await call();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('still clears the session cookie by name, for browsers that ignore the header', async () => {
    const response = await call();
    expect(response.headers.getSetCookie()).toEqual([
      '__Host-drefyn_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
    ]);
  });

  it('ends the session it was given, then goes to sign in with a 303', async () => {
    const response = await call();
    expect(signOut).toHaveBeenCalledExactlyOnceWith(SESSION);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/sign-in`);
  });

  it('surfaces a failed sign out instead of claiming it worked', async () => {
    signOut.mockRejectedValue(new Error('database gone'));
    await expect(call()).rejects.toThrow('database gone');
  });
});

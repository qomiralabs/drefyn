import { encodeSecret } from '@drefyn/auth';
import type * as Auth from '@drefyn/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const set = vi.fn();
const get = vi.fn<(n: string) => { value: string } | undefined>();
const after = vi.fn();
const redirect = vi.fn((to: string) => {
  throw new Error(`REDIRECT ${to}`);
});

vi.mock('next/headers', () => ({ cookies: () => Promise.resolve({ set, get }) }));
vi.mock('next/navigation', () => ({ redirect }));
vi.mock('next/server', () => ({ after }));
vi.mock('../src/server/auth.ts', () => ({
  authConfig: () => ({ cookieSecure: true, cookies: { pre: 'pre' } }),
}));
vi.mock('../src/server/origin.ts', () => ({ appOrigin: () => 'https://app.drefyn.test' }));
vi.mock('@drefyn/auth', async (original) => ({
  ...(await original<typeof Auth>()),
  formBindingField: () => 'bound',
}));

const support = await import('../src/server/sign-in-support.ts');
const SECRET = encodeSecret(Buffer.alloc(32, 7));

beforeEach(() => {
  vi.clearAllMocks();
  get.mockReturnValue(undefined);
});

describe('applyCookies', () => {
  it('sets auth cookies only one way: host only, http only, lax', async () => {
    await support.applyCookies([{ name: 'n', value: 'v', maxAgeSeconds: 60 }]);
    expect(set).toHaveBeenCalledWith({
      name: 'n',
      value: 'v',
      maxAge: 60,
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
    });
  });
});

describe('failureReference', () => {
  it('ties the page to one log line', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const reference = support.failureReference('auth.x');
    expect(reference).toMatch(/^ref_[0-9a-f]{12}$/);
    expect(String(warn.mock.calls[0]?.[0])).toContain(reference);
  });
});

describe('finishSignIn', () => {
  it('mails after the response and stays on this origin', async () => {
    const send = () => Promise.resolve();
    await expect(
      support.finishSignIn({ setCookies: [], returnTo: 'https://evil.example/', send }),
    ).rejects.toThrow('REDIRECT /');
    expect(redirect).toHaveBeenCalledWith('/');
    expect(after).toHaveBeenCalledWith(send);
  });

  it('owes no mail when there is none', async () => {
    await expect(support.finishSignIn({ setCookies: [], returnTo: '/acme' })).rejects.toThrow(
      'REDIRECT /acme',
    );
    expect(after).not.toHaveBeenCalled();
  });
});

describe('formBinding', () => {
  it('sends a browser with no cookie through the mint route', async () => {
    await expect(support.formBinding('/sign-in/verify')).rejects.toThrow(
      'REDIRECT /auth/pre?to=%2Fsign-in%2Fverify',
    );
  });

  it('treats a malformed cookie the same way', async () => {
    get.mockReturnValue({ value: 'not base32!' });
    await expect(support.formBinding('/sign-in')).rejects.toThrow('REDIRECT');
  });

  it('binds the field to a good cookie', async () => {
    get.mockReturnValue({ value: SECRET });
    await expect(support.formBinding('/sign-in')).resolves.toBe('bound');
  });
});

describe('hosted', () => {
  it('reads only an exact true', () => {
    vi.stubEnv('DREFYN_HOSTED', 'yes');
    expect(support.hosted()).toBe(false);
    vi.stubEnv('DREFYN_HOSTED', 'true');
    expect(support.hosted()).toBe(true);
    vi.unstubAllEnvs();
  });
});

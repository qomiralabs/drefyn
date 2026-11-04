import { AuthError, type SessionInfo, type WeakPasswordRule } from '@drefyn/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const REDIRECT = 'NEXT_REDIRECT';
const SESSION = { email: 'maya@acme.dev', userId: 'u' } as unknown as SessionInfo;

const jar = { set: vi.fn(), get: vi.fn<(n: string) => { value: string } | undefined>() };
const after = vi.fn();
const redirect = vi.fn((to: string) => {
  throw new Error(`${REDIRECT} ${to}`);
});
const config = {
  signUp: 'open',
  cookieSecure: true,
  cookies: { invite: 'invite', pre: 'pre' },
};
const auth = {
  account: { setDisplayName: vi.fn(), readAccount: vi.fn() },
  passwordSignIn: { setPassword: vi.fn() },
  organizations: { createOrganization: vi.fn() },
  invitations: { readInvitation: vi.fn() },
};

vi.mock('next/headers', () => ({ cookies: () => Promise.resolve(jar) }));
vi.mock('next/navigation', () => ({ redirect }));
vi.mock('next/server', () => ({ after }));
vi.mock('../src/server/auth.ts', () => ({
  dashboardAuth: () => Promise.resolve(auth),
  authConfig: () => config,
}));
vi.mock('../src/server/origin.ts', () => ({ appOrigin: () => 'https://app.drefyn.test' }));
vi.mock('../src/server/actions.ts', () => ({
  signedInAction:
    (handler: (c: unknown, s: unknown, f: FormData) => Promise<unknown>) =>
    (state: unknown, form: FormData) =>
      handler({ session: SESSION }, state, form),
}));

const { makeOrganization, saveWelcome } = await import('../src/server/first-run-actions.ts');

type Action = (state: unknown, form: FormData) => Promise<unknown>;
const welcome = saveWelcome as unknown as Action;
const create = makeOrganization as unknown as Action;

const form = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) body.set(name, value);
  return body;
};
const refused = (
  code: ConstructorParameters<typeof AuthError>[0],
  rules?: readonly WeakPasswordRule[],
) => ({
  ok: false,
  error: new AuthError(code, rules === undefined ? {} : { rules }),
});
const SAVED = { ok: true, value: { displayName: 'Maya' } };
const send = () => Promise.resolve();

beforeEach(() => {
  vi.clearAllMocks();
  config.signUp = 'open';
  jar.get.mockReturnValue(undefined);
  auth.account.setDisplayName.mockResolvedValue(SAVED);
  auth.passwordSignIn.setPassword.mockResolvedValue({ ok: true, value: { send } });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('saveWelcome', () => {
  it('saves the name and goes to /', async () => {
    await expect(welcome(null, form({ name: 'Maya' }))).rejects.toThrow(`${REDIRECT} /`);
    expect(auth.account.setDisplayName).toHaveBeenCalledWith(SESSION, { name: 'Maya' });
    expect(auth.passwordSignIn.setPassword).not.toHaveBeenCalled();
  });

  it('refuses a name that reads as a link before anything is saved', async () => {
    const state = await welcome(null, form({ name: 'evil.example', password: 'long enough' }));
    expect(state).toEqual({ problem: 'name', name: 'evil.example' });
    expect(auth.passwordSignIn.setPassword).not.toHaveBeenCalled();
    expect(auth.account.setDisplayName).not.toHaveBeenCalled();
  });

  it('saves a password too, and mails its notice after the response', async () => {
    await expect(
      welcome(null, form({ name: 'Maya', password: 'a long sentence here' })),
    ).rejects.toThrow(REDIRECT);
    expect(auth.passwordSignIn.setPassword).toHaveBeenCalledWith(SESSION, {
      newPassword: 'a long sentence here',
    });
    expect(after).toHaveBeenCalledWith(send);
  });

  it.each([
    [refused('AUTH_PASSWORD_WEAK', ['too_short']), { problem: 'password', rules: ['too_short'] }],
    [refused('AUTH_INPUT_INVALID'), { problem: 'password', rules: ['too_long'] }],
    [refused('AUTH_PASSWORD_BREACHED'), { problem: 'breached' }],
    [refused('AUTH_RECENT_AUTH_REQUIRED'), { problem: 'late' }],
  ])('keeps the name, never the password, on %#', async (answer, state) => {
    auth.passwordSignIn.setPassword.mockResolvedValue(answer);
    const out = await welcome(null, form({ name: 'Maya', password: 'hunter2' }));
    expect(out).toEqual({ name: 'Maya', ...state });
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(auth.account.setDisplayName).not.toHaveBeenCalled();
  });

  it('carries on when a password was saved by an earlier try', async () => {
    auth.passwordSignIn.setPassword.mockResolvedValue(refused('AUTH_FORBIDDEN'));
    await expect(welcome(null, form({ name: 'Maya', password: 'x' }))).rejects.toThrow(REDIRECT);
    expect(auth.account.setDisplayName).toHaveBeenCalled();
  });

  it('gives a reference for our own failure', async () => {
    auth.account.setDisplayName.mockResolvedValue(refused('AUTH_UNAVAILABLE'));
    await expect(welcome(null, form({ name: 'Maya' }))).resolves.toMatchObject({
      name: 'Maya',
      notice: { kind: 'not_saved', reference: expect.stringMatching(/^ref_/) as string },
    });
  });

  it('goes on to where the person was heading, on this origin only', async () => {
    await expect(welcome(null, form({ name: 'M', next: '/acme' }))).rejects.toThrow(
      `${REDIRECT} /acme`,
    );
    await expect(welcome(null, form({ name: 'M', next: 'https://evil.example' }))).rejects.toThrow(
      new RegExp(`${REDIRECT} /$`),
    );
  });

  it('goes to a held invitation next, with a fresh form binding', async () => {
    jar.get.mockReturnValue({ value: 'token' });
    auth.invitations.readInvitation.mockResolvedValue({
      ok: true,
      value: { email: 'maya@acme.dev', organizationName: 'Acme', inviterName: 'Priya' },
    });
    await expect(welcome(null, form({ name: 'Maya' }))).rejects.toThrow(`${REDIRECT} /invite`);
    expect(jar.set).toHaveBeenCalledWith(expect.objectContaining({ name: 'pre' }));
  });
});

describe('makeOrganization', () => {
  const FIELDS = { name: 'Acme', slug: 'acme' };
  const MADE = { ok: true, value: {} };

  it('creates the organization and opens it', async () => {
    auth.organizations.createOrganization.mockResolvedValue(MADE);
    await expect(create(null, form(FIELDS))).rejects.toThrow(`${REDIRECT} /acme`);
    expect(auth.organizations.createOrganization).toHaveBeenCalledWith(SESSION, FIELDS);
  });

  it.each(['invite_only', 'closed'])('creates nothing where sign up is %s', async (mode) => {
    config.signUp = mode;
    await expect(create(null, form(FIELDS))).resolves.toEqual({ closed: true });
    expect(auth.organizations.createOrganization).not.toHaveBeenCalled();
  });

  it.each([
    ['AUTH_SLUG_TAKEN', { problem: 'taken' }],
    ['AUTH_SLUG_INVALID', { problem: 'address' }],
    ['AUTH_INPUT_INVALID', { problem: 'name' }],
    ['AUTH_RATE_LIMITED', { limited: true }],
  ] as const)('keeps what was typed on %s', async (code, state) => {
    auth.organizations.createOrganization.mockResolvedValue(refused(code));
    await expect(create(null, form(FIELDS))).resolves.toEqual({ ...FIELDS, ...state });
  });

  it('gives a reference for our own failure', async () => {
    auth.organizations.createOrganization.mockResolvedValue(refused('AUTH_UNAVAILABLE'));
    await expect(create(null, form(FIELDS))).resolves.toMatchObject({
      ...FIELDS,
      notice: { kind: 'not_saved', reference: expect.stringMatching(/^ref_/) as string },
    });
  });
});

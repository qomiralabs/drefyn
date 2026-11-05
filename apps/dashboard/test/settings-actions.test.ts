import { ApiKeyReplayError, AuthError } from '@drefyn/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const after = vi.fn();
const set = vi.fn();
const send = vi.fn(() => Promise.resolve());
const AT = new Date('2026-10-31T10:00:00.000Z');
const SESSION = { email: 'maya@acme.dev', authenticatedAt: AT };
const manager = { permissions: ['org.manage_members'] };
const access = { current: manager as { permissions: readonly string[] } };

const auth = {
  account: { setDisplayName: vi.fn(), readAccount: vi.fn() },
  emailChange: { startEmailChange: vi.fn(), completeEmailChange: vi.fn() },
  passwordSignIn: { setPassword: vi.fn() },
  passwordAccount: { changePassword: vi.fn(), removePassword: vi.fn() },
  oauth: { unlinkIdentity: vi.fn() },
  sessions: {
    requireRecentAuth: vi.fn(),
    revokeSession: vi.fn(),
    signOutOtherSessions: vi.fn(),
    stepUpWithPassword: vi.fn(),
    startStepUpCode: vi.fn(),
    verifyStepUpCode: vi.fn(),
  },
  invitations: { invite: vi.fn() },
  members: { withdrawInvitation: vi.fn(), setDefaultProjectRole: vi.fn() },
  roles: { changeRole: vi.fn(), removeMember: vi.fn(), setProjectRole: vi.fn() },
  apiKeys: { createApiKey: vi.fn(), revokeApiKey: vi.fn(), listApiKeys: vi.fn() },
  methods: { email: true },
};

vi.mock('next/headers', () => ({ cookies: () => Promise.resolve({ set }) }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next/server', () => ({ after }));
vi.mock('../src/server/log.ts', () => ({ logWarn: vi.fn() }));
vi.mock('../src/server/auth.ts', () => ({
  dashboardAuth: () => Promise.resolve(auth),
  authConfig: () => ({ cookieSecure: true, cookies: {} }),
}));
vi.mock('../src/server/origin.ts', () => ({ appOrigin: () => 'https://app.drefyn.test' }));
const BROWSER = { ip: '203.0.113.9', userAgent: 'x', cookies: new Map() };
vi.mock('../src/server/actions.ts', () => ({
  signedInAction:
    (handler: (c: unknown, ...a: unknown[]) => Promise<unknown>) =>
    (...args: unknown[]) =>
      handler({ browser: BROWSER, session: SESSION }, ...args),
  orgAction:
    (handler: (c: unknown, ...a: unknown[]) => Promise<unknown>) =>
    (_slug: string, ...args: unknown[]) =>
      handler({ browser: BROWSER, access: access.current }, ...args),
}));

const actions = await import('../src/server/settings-actions.ts');

const yes = <T>(value: T) => ({ ok: true, value });
const no = (code: ConstructorParameters<typeof AuthError>[0], detail = {}) => ({
  ok: false,
  error: new AuthError(code, detail),
});

beforeEach(() => {
  vi.clearAllMocks();
  access.current = manager;
});

describe('what a refusal becomes', () => {
  it('asks for a step up when the sign in is stale', async () => {
    auth.passwordAccount.removePassword.mockResolvedValue(no('AUTH_RECENT_AUTH_REQUIRED'));
    expect(await actions.removePassword()).toEqual({ ok: false, problem: { kind: 'step_up' } });
  });

  it('says how long a limit lasts, in minutes', async () => {
    auth.oauth.unlinkIdentity.mockResolvedValue(no('AUTH_RATE_LIMITED', { retryAfterSeconds: 90 }));
    expect(await actions.unlinkProvider('github')).toEqual({
      ok: false,
      problem: { kind: 'limited', minutes: 2 },
    });
  });

  it('gives our own failure a reference and hides the cause', async () => {
    auth.account.setDisplayName.mockResolvedValue(no('AUTH_UNAVAILABLE'));
    const answer = await actions.saveName('Maya');
    expect(answer).toMatchObject({ ok: false, problem: { kind: 'failed' } });
    expect(JSON.stringify(answer)).toMatch(/ref_[0-9a-f]{12}/);
  });

  it('passes a rule by its code', async () => {
    auth.oauth.unlinkIdentity.mockResolvedValue(no('AUTH_FORBIDDEN'));
    expect(await actions.unlinkProvider('github')).toEqual({
      ok: false,
      problem: { kind: 'refused', code: 'AUTH_FORBIDDEN' },
    });
  });
});

describe('mail and cookies', () => {
  it('sets cookies and mails after the response on an email change', async () => {
    auth.emailChange.startEmailChange.mockResolvedValue(
      yes({ setCookies: [{ name: 'c', value: 'v', maxAgeSeconds: 1 }], send }),
    );
    expect(await actions.beginEmailChange('new@acme.dev')).toEqual(yes(undefined));
    expect(set).toHaveBeenCalledOnce();
    expect(after).toHaveBeenCalledWith(send);
  });

  it('sets the first password through the path that refuses a second', async () => {
    auth.passwordSignIn.setPassword.mockResolvedValue(yes({ send }));
    await actions.savePassword({ first: true, newPassword: 'x' });
    expect(auth.passwordSignIn.setPassword).toHaveBeenCalled();
    expect(auth.passwordAccount.changePassword).not.toHaveBeenCalled();
  });

  it('keeps this browser signed in when others are signed out', async () => {
    auth.sessions.signOutOtherSessions.mockResolvedValue(
      yes({ revoked: 2, setCookies: [{ name: 's', value: 'new', maxAgeSeconds: 9 }] }),
    );
    expect(await actions.signOutOthers()).toEqual(yes(2));
    expect(set).toHaveBeenCalledOnce();
  });

  it('reads a session already gone as done', async () => {
    auth.sessions.revokeSession.mockResolvedValue(no('AUTH_NOT_FOUND'));
    expect(await actions.signOutSession('ses')).toEqual(yes(undefined));
  });

  it('does not read a refused current session as done', async () => {
    auth.sessions.revokeSession.mockResolvedValue(no('AUTH_FORBIDDEN'));
    const answer = await actions.signOutSession('ses');
    expect(answer.ok).toBe(false);
  });
});

describe('step up', () => {
  it('offers what the person has, and never reads a hash', async () => {
    auth.account.readAccount.mockResolvedValue(
      yes({ passwordSetAt: AT, identities: [{ provider: 'google' }] }),
    );
    expect(await actions.stepUpChoices()).toEqual(
      yes({
        address: 'maya@acme.dev',
        lastSignIn: AT.toISOString(),
        password: true,
        email: true,
        google: true,
        github: false,
      }),
    );
  });

  it('returns the challenge and mails after the response', async () => {
    auth.sessions.startStepUpCode.mockResolvedValue(yes({ challenge: 'c1', send }));
    expect(await actions.stepUpSendCode()).toEqual(yes('c1'));
    expect(after).toHaveBeenCalledWith(send);
  });
});

describe('invitations', () => {
  const input = { role: 'member', defaultProjectRole: null } as const;

  it('says what happened to each address', async () => {
    auth.invitations.invite
      .mockResolvedValueOnce(yes({ kind: 'sent', send }))
      .mockResolvedValueOnce(no('AUTH_ALREADY_MEMBER'))
      .mockResolvedValueOnce(yes({ kind: 'blocked' }));
    const answer = await actions.sendInvitations('acme', {
      ...input,
      emails: ['a@acme.dev', 'b@acme.dev', 'c@acme.dev', 'not an address'],
    });
    expect(answer).toEqual(
      yes([
        { email: 'a@acme.dev', result: 'sent' },
        { email: 'b@acme.dev', result: 'member' },
        { email: 'c@acme.dev', result: 'blocked' },
        { email: 'not an address', result: 'invalid' },
      ]),
    );
  });

  it('stops at the seat limit and tries nothing more', async () => {
    auth.invitations.invite.mockResolvedValueOnce(no('AUTH_SEAT_LIMIT'));
    const answer = await actions.sendInvitations('acme', {
      ...input,
      emails: ['a@acme.dev', 'b@acme.dev'],
    });
    expect(answer).toEqual(
      yes([
        { email: 'a@acme.dev', result: 'limit' },
        { email: 'b@acme.dev', result: 'waiting' },
      ]),
    );
    expect(auth.invitations.invite).toHaveBeenCalledOnce();
  });

  it('asks for a step up only before anything went out', async () => {
    auth.invitations.invite.mockResolvedValueOnce(no('AUTH_RECENT_AUTH_REQUIRED'));
    expect(await actions.sendInvitations('acme', { ...input, emails: ['a@acme.dev'] })).toEqual({
      ok: false,
      problem: { kind: 'step_up' },
    });
  });

  it('refuses an empty list and a list past one dialog', async () => {
    const big = Array.from({ length: 21 }, (_, i) => `p${String(i)}@acme.dev`);
    for (const emails of [[], big]) {
      expect(await actions.sendInvitations('acme', { ...input, emails })).toMatchObject({
        ok: false,
      });
    }
    expect(auth.invitations.invite).not.toHaveBeenCalled();
  });
});

describe('removal', () => {
  it('lists only keys that still work, for someone who manages people', async () => {
    auth.apiKeys.listApiKeys.mockResolvedValue(
      yes({
        nextCursor: null,
        items: [
          { keyId: 'k1', name: 'live', displaySuffix: 'ab', revokedAt: null, lastUsedAt: AT },
          { keyId: 'k2', name: 'dead', displaySuffix: 'cd', revokedAt: AT, lastUsedAt: null },
        ],
      }),
    );
    expect(await actions.keysOfMember('acme', 'm1')).toEqual(
      yes({
        keys: [{ keyId: 'k1', name: 'live', suffix: 'ab', lastUsedAt: AT.toISOString() }],
        more: false,
      }),
    );
  });

  it('refuses a member before reading anything', async () => {
    access.current = { permissions: ['org.read'] };
    expect(await actions.keysOfMember('acme', 'm1')).toMatchObject({ ok: false });
    expect(auth.apiKeys.listApiKeys).not.toHaveBeenCalled();
  });
});

describe('project access', () => {
  it('sets the fallback only when it changed, then each project', async () => {
    auth.roles.setProjectRole.mockResolvedValue(yes(undefined));
    await actions.saveProjectAccess('acme', 'm1', {
      changes: [{ projectId: 'p1', role: 'viewer' }],
    });
    expect(auth.members.setDefaultProjectRole).not.toHaveBeenCalled();
    expect(auth.roles.setProjectRole).toHaveBeenCalledOnce();
  });

  it('stops at the first refusal', async () => {
    auth.members.setDefaultProjectRole.mockResolvedValue(no('AUTH_RECENT_AUTH_REQUIRED'));
    const answer = await actions.saveProjectAccess('acme', 'm1', {
      fallback: 'viewer',
      changes: [{ projectId: 'p1', role: 'viewer' }],
    });
    expect(answer).toEqual({ ok: false, problem: { kind: 'step_up' } });
    expect(auth.roles.setProjectRole).not.toHaveBeenCalled();
  });
});

describe('API keys', () => {
  const input = {
    name: 'ci',
    scopes: ['docs:pages.read'],
    projectScope: 'all',
    projectIds: ['ignored'],
    expiresInDays: 90,
    idempotencyKey: 'once',
  } as const;

  it('returns the secret once and passes no projects for all projects', async () => {
    auth.apiKeys.createApiKey.mockResolvedValue(
      yes({
        secret: 'drf_ak_x',
        send,
        key: { name: 'ci', scopes: [], projectScope: 'all', projectIds: [], expiresAt: null },
      }),
    );
    const answer = await actions.createKey('acme', input);
    expect(answer).toMatchObject({ ok: true, value: { secret: 'drf_ak_x', expiresAt: null } });
    const sent = auth.apiKeys.createApiKey.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('projectIds');
    expect(sent['expiresAt']).toBeInstanceOf(Date);
  });

  it('says a replay plainly, with no secret', async () => {
    auth.apiKeys.createApiKey.mockResolvedValue({
      ok: false,
      error: new ApiKeyReplayError({} as never),
    });
    expect(await actions.createKey('acme', input)).toEqual({
      ok: false,
      problem: { kind: 'refused', code: 'AUTH_IDEMPOTENCY_REPLAY' },
    });
  });

  it('reads a second revoke as plain success', async () => {
    const quiet = vi.fn(() => Promise.resolve());
    auth.apiKeys.revokeApiKey.mockResolvedValue(yes({ alreadyRevoked: true, send: quiet }));
    expect(await actions.revokeKey('acme', 'k1')).toEqual(yes(undefined));
    expect(after).toHaveBeenCalledWith(quiet);
  });
});

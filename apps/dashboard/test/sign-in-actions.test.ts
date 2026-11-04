import { AuthError, formatChallengeId, formatVerifyFragment } from '@drefyn/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const REDIRECT = 'NEXT_REDIRECT';
const CHALLENGE = '01890a5d-ac96-774b-bcce-b302099a8070';
const PUBLIC = formatChallengeId(CHALLENGE);

const jar = { set: vi.fn(), get: vi.fn<(n: string) => { value: string } | undefined>() };
const after = vi.fn();
const redirect = vi.fn((to: string) => {
  throw new Error(`${REDIRECT} ${to}`);
});
const currentSession = vi.fn(() => Promise.resolve<{ email: string } | null>(null));

const auth = {
  emailSignIn: {
    startEmailSignIn: vi.fn(),
    verifyEmailCode: vi.fn(),
    readChallenge: vi.fn(),
    verifyLinkCode: vi.fn(),
  },
  passwordSignIn: { signInWithPassword: vi.fn() },
  passwordAccount: { startPasswordReset: vi.fn(), completePasswordReset: vi.fn() },
  cliLinks: { redeem: vi.fn() },
  invitations: {
    readInvitation: vi.fn(),
    holdInvitation: vi.fn(),
    acceptInvitation: vi.fn(),
    readInvitationBlock: vi.fn(),
    blockInvitation: vi.fn(),
  },
  organizations: { listMyOrganizations: vi.fn() },
};

vi.mock('next/headers', () => ({ cookies: () => Promise.resolve(jar) }));
vi.mock('next/navigation', () => ({ redirect }));
vi.mock('next/server', () => ({ after }));
vi.mock('../src/server/guard.ts', () => ({ currentSession }));
vi.mock('../src/server/auth.ts', () => ({
  dashboardAuth: () => Promise.resolve(auth),
  authConfig: () => ({ cookieSecure: true, cookies: { invite: 'invite', pre: 'pre' } }),
}));
vi.mock('../src/server/origin.ts', () => ({ appOrigin: () => 'https://app.drefyn.test' }));
const BROWSER = { ip: '203.0.113.9', userAgent: 'x', cookies: new Map() };
vi.mock('../src/server/actions.ts', () => ({
  publicAction: (handler: (c: unknown, f: FormData) => Promise<unknown>) => (form: FormData) =>
    handler({ browser: BROWSER }, form),
  signedInAction:
    (handler: (c: unknown, s: unknown, f: FormData) => Promise<unknown>) =>
    (state: unknown, form: FormData) =>
      handler({ browser: BROWSER, session: { email: 'a@example.com' } }, state, form),
}));

const actions = await import('../src/server/sign-in-actions.ts');
const call = actions as unknown as Record<string, (form: FormData) => Promise<unknown>>;
const join = actions.joinInvitation as unknown as (s: unknown, f: FormData) => Promise<unknown>;

const form = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) body.set(name, value);
  return body;
};
const refused = (code: ConstructorParameters<typeof AuthError>[0], seconds?: number) => ({
  ok: false,
  error: new AuthError(code, seconds === undefined ? {} : { retryAfterSeconds: seconds }),
});
const SIGNED = { setCookies: [], returnTo: '/acme' };
const started = { ok: true, value: { setCookies: [], send: () => Promise.resolve() } };

beforeEach(() => {
  vi.clearAllMocks();
  currentSession.mockResolvedValue(null);
  jar.get.mockReturnValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('startEmail', () => {
  it('sends no statement for a bad address', async () => {
    await expect(call['startEmail']?.(form({ email: 'maya@acme' }))).resolves.toEqual({
      invalid: true,
      email: 'maya@acme',
    });
    expect(auth.emailSignIn.startEmailSignIn).not.toHaveBeenCalled();
  });

  it('mails after the response and goes to verify, with no address in the URL', async () => {
    auth.emailSignIn.startEmailSignIn.mockResolvedValue(started);
    await expect(call['startEmail']?.(form({ email: 'a@example.com' }))).rejects.toThrow(
      `${REDIRECT} /sign-in/verify`,
    );
    expect(after).toHaveBeenCalledOnce();
  });

  it('marks a sign up in the URL', async () => {
    auth.emailSignIn.startEmailSignIn.mockResolvedValue(started);
    await expect(
      call['startEmail']?.(form({ email: 'a@example.com', from: 'sign-up' })),
    ).rejects.toThrow('from=sign-up');
  });

  it('turns a limit into minutes', async () => {
    auth.emailSignIn.startEmailSignIn.mockResolvedValue(refused('AUTH_RATE_LIMITED', 840));
    await expect(call['startEmail']?.(form({ email: 'a@example.com' }))).resolves.toMatchObject({
      notice: { kind: 'limited', minutes: 14 },
    });
  });

  it('gives a reference for our own failure', async () => {
    auth.emailSignIn.startEmailSignIn.mockResolvedValue(refused('AUTH_UNAVAILABLE'));
    await expect(call['startEmail']?.(form({ email: 'a@example.com' }))).resolves.toMatchObject({
      notice: { kind: 'unavailable', reference: expect.stringMatching(/^ref_/) as string },
    });
  });
});

describe('verifyCode', () => {
  it('lands where the sign in says', async () => {
    auth.emailSignIn.verifyEmailCode.mockResolvedValue({ ok: true, value: SIGNED });
    await expect(call['verifyCode']?.(form({ code: '12345678' }))).rejects.toThrow('/acme');
  });

  it.each([
    ['AUTH_CODE_INVALID', { problem: 'wrong', code: '12345678' }],
    ['AUTH_CHALLENGE_EXPIRED', { problem: 'expired' }],
    ['AUTH_CHALLENGE_BINDING', { problem: 'expired' }],
    ['AUTH_SIGNUP_CLOSED', { problem: 'closed' }],
  ] as const)('reads %s for the person', async (code, state) => {
    auth.emailSignIn.verifyEmailCode.mockResolvedValue(refused(code));
    await expect(call['verifyCode']?.(form({ code: '12345678' }))).resolves.toEqual(state);
  });

  it('keeps the code in the field after a limit', async () => {
    auth.emailSignIn.verifyEmailCode.mockResolvedValue(refused('AUTH_RATE_LIMITED', 60));
    await expect(call['verifyCode']?.(form({ code: '12345678' }))).resolves.toMatchObject({
      code: '12345678',
      notice: { kind: 'limited' },
    });
  });
});

describe('the link in the mail', () => {
  const fragment = formatVerifyFragment({ challengeId: CHALLENGE, code: '12345678' });

  it('reads a malformed fragment as gone, with no statement', async () => {
    await expect(call['inspectLink']?.(form({ fragment: 'nope' }))).resolves.toEqual({
      kind: 'gone',
    });
    expect(auth.emailSignIn.readChallenge).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'gone' }, { kind: 'gone' }],
    [{ kind: 'elsewhere' }, { kind: 'elsewhere', code: '12345678' }],
    [
      { kind: 'here', email: 'a@example.com', purpose: 'sign_in', provider: null },
      {
        kind: 'here',
        email: 'a@example.com',
        purpose: 'sign_in',
        challenge: PUBLIC,
        code: '12345678',
      },
    ],
  ])('turns %j into a page state', async (value, state) => {
    auth.emailSignIn.readChallenge.mockResolvedValue({ ok: true, value });
    await expect(call['inspectLink']?.(form({ fragment }))).resolves.toEqual(state);
  });

  it('shows the failure when the read fails', async () => {
    auth.emailSignIn.readChallenge.mockResolvedValue(refused('AUTH_UNAVAILABLE'));
    await expect(call['inspectLink']?.(form({ fragment }))).resolves.toMatchObject({
      kind: 'failed',
    });
  });

  const finish = () => call['finishLink']?.(form({ challenge: PUBLIC, code: '12345678' }));

  it('signs in on Continue', async () => {
    auth.emailSignIn.verifyLinkCode.mockResolvedValue({
      ok: true,
      value: { kind: 'signed_in', signedIn: SIGNED },
    });
    await expect(finish()).rejects.toThrow('/acme');
  });

  it('moves a reset code to the password step, spending nothing', async () => {
    auth.emailSignIn.verifyLinkCode.mockResolvedValue({
      ok: true,
      value: { kind: 'choose_password' },
    });
    await expect(finish()).resolves.toEqual({
      kind: 'choose',
      challenge: PUBLIC,
      code: '12345678',
    });
  });

  it('runs the change notice after the response', async () => {
    const send = () => Promise.resolve();
    auth.emailSignIn.verifyLinkCode.mockResolvedValue({
      ok: true,
      value: { kind: 'email_changed', send },
    });
    await expect(finish()).rejects.toThrow(`${REDIRECT} /`);
    expect(after).toHaveBeenCalledWith(send);
  });

  it.each([
    ['AUTH_CHALLENGE_BINDING', { kind: 'elsewhere', code: '12345678' }],
    ['AUTH_CODE_INVALID', { kind: 'gone' }],
  ] as const)('reads %s', async (code, state) => {
    auth.emailSignIn.verifyLinkCode.mockResolvedValue(refused(code));
    await expect(finish()).resolves.toEqual(state);
  });

  it('reports a limit', async () => {
    auth.emailSignIn.verifyLinkCode.mockResolvedValue(refused('AUTH_RATE_LIMITED', 60));
    await expect(finish()).resolves.toMatchObject({ kind: 'failed' });
  });
});

describe('signInPassword', () => {
  const post = () =>
    call['signInPassword']?.(form({ email: 'a@example.com', password: 'x', csrf: 'c' }));

  it('signs in', async () => {
    auth.passwordSignIn.signInWithPassword.mockResolvedValue({ ok: true, value: SIGNED });
    await expect(post()).rejects.toThrow('/acme');
  });

  it.each(['AUTH_CREDENTIALS_INVALID', 'AUTH_INPUT_INVALID'] as const)(
    'answers %s with the one message, never saying which field',
    async (code) => {
      auth.passwordSignIn.signInWithPassword.mockResolvedValue(refused(code));
      await expect(post()).resolves.toEqual({ wrong: true, email: 'a@example.com' });
    },
  );

  it('reads a failed bot check as paused', async () => {
    auth.passwordSignIn.signInWithPassword.mockResolvedValue(refused('AUTH_BOT_CHECK_REQUIRED'));
    await expect(post()).resolves.toMatchObject({ notice: { kind: 'botcheck_down' } });
  });
});

describe('resetStep', () => {
  const save = () =>
    call['resetStep']?.(form({ step: 'save', code: '12345678', challenge: '', password: 'p' }));

  it('refuses a bad address', async () => {
    await expect(call['resetStep']?.(form({ step: 'ask', email: 'x' }))).resolves.toMatchObject({
      step: 'ask',
      invalid: true,
    });
  });

  it('moves to the code step', async () => {
    auth.passwordAccount.startPasswordReset.mockResolvedValue(started);
    await expect(
      call['resetStep']?.(form({ step: 'ask', email: 'a@example.com' })),
    ).resolves.toEqual({ step: 'code', email: 'a@example.com' });
  });

  it('reports a failed start', async () => {
    auth.passwordAccount.startPasswordReset.mockResolvedValue(refused('AUTH_RATE_LIMITED', 60));
    await expect(
      call['resetStep']?.(form({ step: 'ask', email: 'a@example.com' })),
    ).resolves.toMatchObject({ notice: { kind: 'limited' } });
  });

  it('drops typed gaps and keeps the code for the password step', async () => {
    await expect(
      call['resetStep']?.(form({ step: 'code', code: '1234 5678', challenge: '' })),
    ).resolves.toEqual({ step: 'choose', code: '12345678', challenge: '' });
  });

  it('says saved, never where the password went', async () => {
    auth.passwordAccount.completePasswordReset.mockResolvedValue({
      ok: true,
      value: { ...SIGNED, session: { email: 'a@example.com' } },
    });
    await expect(save()).resolves.toEqual({
      step: 'saved',
      email: 'a@example.com',
      returnTo: '/acme',
    });
  });

  it('names the rule a weak password broke', async () => {
    auth.passwordAccount.completePasswordReset.mockResolvedValue({
      ok: false,
      error: new AuthError('AUTH_PASSWORD_WEAK', { rules: ['too_short'] }),
    });
    await expect(save()).resolves.toMatchObject({ step: 'choose', rules: ['too_short'] });
  });

  it.each([
    ['AUTH_PASSWORD_BREACHED', { step: 'choose', breached: true }],
    ['AUTH_CODE_INVALID', { step: 'code', wrong: true }],
    ['AUTH_CHALLENGE_EXPIRED', { step: 'ask', expired: true }],
    ['AUTH_CHALLENGE_BINDING', { step: 'ask', expired: true }],
    ['AUTH_UNAVAILABLE', { step: 'choose', notice: { kind: 'unavailable' } }],
  ] as const)('reads %s', async (code, state) => {
    auth.passwordAccount.completePasswordReset.mockResolvedValue(refused(code));
    await expect(save()).resolves.toMatchObject(state);
  });
});

describe('redeemCliLink', () => {
  it('signs in and lands at the root', async () => {
    auth.cliLinks.redeem.mockResolvedValue({ ok: true, value: { setCookies: [] } });
    await expect(call['redeemCliLink']?.(form({ token: ' t ' }))).rejects.toThrow(`${REDIRECT} /`);
    expect(auth.cliLinks.redeem).toHaveBeenCalledWith(BROWSER, 't');
  });

  it('has one answer for every bad link', async () => {
    auth.cliLinks.redeem.mockResolvedValue(refused('AUTH_CLI_LINK_INVALID'));
    await expect(call['redeemCliLink']?.(form({ token: 't' }))).resolves.toEqual({
      kind: 'invalid',
    });
  });

  it('reports a limit', async () => {
    auth.cliLinks.redeem.mockResolvedValue(refused('AUTH_RATE_LIMITED', 60));
    await expect(call['redeemCliLink']?.(form({ token: 't' }))).resolves.toMatchObject({
      kind: 'failed',
    });
  });
});

describe('invitations', () => {
  const view = {
    organizationName: 'Acme',
    inviterName: 'Priya',
    email: 'a@example.com',
    role: 'member',
    defaultProjectRole: null,
    expiresAt: new Date('2026-11-06T14:20:00Z'),
    blockLink: new URL('https://app.drefyn.test/invite/block#b'),
  };

  it('is invalid with no token and none held', async () => {
    await expect(call['openInvitation']?.(form({}))).resolves.toEqual({ kind: 'invalid' });
  });

  it('falls back to the held cookie, for the return from sign in', async () => {
    jar.get.mockReturnValue({ value: 'held' });
    auth.invitations.readInvitation.mockResolvedValue(refused('AUTH_INVITATION_INVALID'));
    await call['openInvitation']?.(form({}));
    expect(auth.invitations.readInvitation).toHaveBeenCalledWith('held');
  });

  it('holds the token for someone signed out, with only path and fragment in the link', async () => {
    auth.invitations.readInvitation.mockResolvedValue({ ok: true, value: view });
    auth.invitations.holdInvitation.mockReturnValue({ ok: true, value: { setCookies: [] } });
    await expect(call['openInvitation']?.(form({ token: 't' }))).resolves.toMatchObject({
      kind: 'signed_out',
      blockHref: '/invite/block#b',
    });
    expect(auth.invitations.holdInvitation).toHaveBeenCalledOnce();
  });

  it('matches by normalized address', async () => {
    auth.invitations.readInvitation.mockResolvedValue({ ok: true, value: view });
    currentSession.mockResolvedValue({ email: 'A@Example.com' });
    await expect(call['openInvitation']?.(form({ token: 't' }))).resolves.toMatchObject({
      kind: 'match',
      token: 't',
    });
  });

  it('shows the mismatch', async () => {
    auth.invitations.readInvitation.mockResolvedValue({ ok: true, value: view });
    currentSession.mockResolvedValue({ email: 'b@example.com' });
    await expect(call['openInvitation']?.(form({ token: 't' }))).resolves.toMatchObject({
      kind: 'mismatch',
      signedInAs: 'b@example.com',
    });
  });

  it('reports a failed read', async () => {
    auth.invitations.readInvitation.mockResolvedValue(refused('AUTH_UNAVAILABLE'));
    await expect(call['openInvitation']?.(form({ token: 't' }))).resolves.toMatchObject({
      kind: 'failed',
    });
  });

  it('joins and lands in the organization', async () => {
    auth.invitations.acceptInvitation.mockResolvedValue({
      ok: true,
      value: { access: { organizationId: 'o' }, setCookies: [] },
    });
    auth.organizations.listMyOrganizations.mockResolvedValue([
      { organizationId: 'o', slug: 'acme' },
    ]);
    await expect(join(null, form({ token: 't' }))).rejects.toThrow('/acme');
  });

  it.each(['AUTH_INVITATION_EMAIL_MISMATCH', 'AUTH_INVITATION_INVALID'] as const)(
    'reads %s as an invitation that no longer works',
    async (code) => {
      auth.invitations.acceptInvitation.mockResolvedValue(refused(code));
      await expect(join(null, form({ token: 't' }))).resolves.toEqual({ kind: 'invalid' });
    },
  );
});

describe('the block page', () => {
  const read = { ok: true, value: { organizationName: 'Acme' } };

  it('only reads until the button', async () => {
    auth.invitations.readInvitationBlock.mockResolvedValue(read);
    await expect(call['readBlock']?.(form({ token: 't' }))).resolves.toEqual({
      kind: 'ask',
      organizationName: 'Acme',
      token: 't',
    });
    expect(auth.invitations.blockInvitation).not.toHaveBeenCalled();
  });

  it('is invalid for a bad token', async () => {
    auth.invitations.readInvitationBlock.mockResolvedValue(refused('AUTH_INVITATION_INVALID'));
    await expect(call['readBlock']?.(form({ token: 't' }))).resolves.toEqual({ kind: 'invalid' });
  });

  it('reports a failed read', async () => {
    auth.invitations.readInvitationBlock.mockResolvedValue(refused('AUTH_UNAVAILABLE'));
    await expect(call['readBlock']?.(form({ token: 't' }))).resolves.toMatchObject({
      kind: 'failed',
    });
  });

  it('blocks on the button', async () => {
    auth.invitations.readInvitationBlock.mockResolvedValue(read);
    auth.invitations.blockInvitation.mockResolvedValue({ ok: true, value: undefined });
    await expect(call['stopInvitations']?.(form({ token: 't' }))).resolves.toEqual({
      kind: 'done',
      organizationName: 'Acme',
    });
  });

  it('reports a failed write', async () => {
    auth.invitations.readInvitationBlock.mockResolvedValue(read);
    auth.invitations.blockInvitation.mockResolvedValue(refused('AUTH_UNAVAILABLE'));
    await expect(call['stopInvitations']?.(form({ token: 't' }))).resolves.toMatchObject({
      kind: 'failed',
    });
  });

  it('is invalid when the token fails', async () => {
    auth.invitations.readInvitationBlock.mockResolvedValue(refused('AUTH_INVITATION_INVALID'));
    auth.invitations.blockInvitation.mockResolvedValue(refused('AUTH_INVITATION_INVALID'));
    await expect(call['stopInvitations']?.(form({ token: 't' }))).resolves.toEqual({
      kind: 'invalid',
    });
  });
});

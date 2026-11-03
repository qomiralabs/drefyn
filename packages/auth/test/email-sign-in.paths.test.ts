import type { AuthDatabase, Database } from '@drefyn/db';
import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  AuthError,
  createCodeIssuer,
  createEmailSignIn,
  encodeSecret,
  formatChallengeId,
  parseAuthConfig,
  recordDevice,
  sha256,
  type AuthConfig,
  type SessionInfo,
} from '../src/index.ts';
import { scriptedStore, type Responder } from './scripted-store.ts';
import {
  ADDRESS,
  CHALLENGE,
  USER,
  browser,
  challengeRow,
  config,
  emailResponder,
  on,
  recordingLogger,
  session,
  unitDeps,
} from './email-fixtures.ts';
import { validEnv } from './support.ts';

const codeHmac = (code: string) => config.keys.mac('code', [CHALLENGE, 'sign_in', code]);
const RIGHT = '48312097';
const challengeArg = formatChallengeId(CHALLENGE);

// A challenge for an address that had no account when the code was sent.
function newcomer(options: { users?: readonly string[]; inserted?: boolean } = {}): Responder {
  const row = challengeRow({ userId: null, codeHmac: codeHmac(RIGHT) });
  return (s) => {
    if (on(s, 'select', 'email_challenges') || on(s, 'update', 'email_challenges')) return [row];
    if (on(s, 'insert', 'users')) return options.inserted === false ? [] : [{ id: USER }];
    if (on(s, 'select', 'users')) return (options.users ?? []).map((id) => ({ id }));
    return [];
  };
}

function flowWith(responder: Responder, cfg: AuthConfig = config, extra: object = {}) {
  const t = unitDeps(responder);
  return { ...t, flow: createEmailSignIn(cfg, { ...t.deps, ...extra }) };
}

const withMode = (mode: string) => parseAuthConfig({ ...validEnv(), DREFYN_AUTH_SIGNUP: mode });

// The newcomer responder, but with codes made under the config the test uses.
function newcomerFor(cfg: AuthConfig, options: Parameters<typeof newcomer>[0] = {}): Responder {
  const row = challengeRow({
    userId: null,
    codeHmac: cfg.keys.mac('code', [CHALLENGE, 'sign_in', RIGHT]),
  });
  const base = newcomer(options);
  return (s) =>
    on(s, 'select', 'email_challenges') || on(s, 'update', 'email_challenges') ? [row] : base(s);
}

describe('verify for an address with no account at send time', () => {
  it('uses the account made since, without creating another', async () => {
    const { flow, scripted, sessions } = flowWith(newcomer({ users: [USER] }));
    const result = await flow.verifyEmailCode(browser(), { challenge: challengeArg, code: RIGHT });
    expect(result.ok).toBe(true);
    expect(scripted.writes().some((s) => on(s, 'insert', 'users'))).toBe(false);
    expect(sessions.startSession).toHaveBeenCalledWith(expect.anything(), {
      userId: USER,
      method: 'email',
    });
  });

  it('creates the user in open mode, with the address as proved', async () => {
    const open = withMode('open');
    const { flow, scripted } = flowWith(newcomerFor(open), open);
    const result = await flow.verifyEmailCode(browser(), { challenge: challengeArg, code: RIGHT });
    expect(result.ok).toBe(true);
    const insert = scripted.writes().find((s) => on(s, 'insert', 'users'));
    expect(insert?.sql).toMatch(/on conflict \("email_normalized"\) do nothing returning "id"$/);
    expect(insert?.parameters).toContain(ADDRESS);
  });

  it('takes the row a racing sign up made when its own insert conflicts', async () => {
    const open = withMode('open');
    let reads = 0;
    const base = newcomerFor(open, { inserted: false });
    const { flow } = flowWith((s) => {
      if (on(s, 'select', 'users')) {
        reads += 1;
        return reads === 1 ? [] : [{ id: USER }];
      }
      return base(s);
    }, open);
    const result = await flow.verifyEmailCode(browser(), { challenge: challengeArg, code: RIGHT });
    expect(result.ok).toBe(true);
    expect(reads).toBe(2);
  });

  it('answers AUTH_SIGNUP_CLOSED in closed mode and in invite_only without an invitation', async () => {
    for (const mode of ['closed', 'invite_only']) {
      const cfg = withMode(mode);
      const { flow, sessions } = flowWith(newcomerFor(cfg), cfg);
      const result = await flow.verifyEmailCode(browser(), {
        challenge: challengeArg,
        code: RIGHT,
      });
      expect(!result.ok && result.error.code).toBe('AUTH_SIGNUP_CLOSED');
      expect(sessions.startSession).not.toHaveBeenCalled();
    }
  });

  it('lets invite_only create the user when an invitation is pending', async () => {
    const cfg = withMode('invite_only');
    const hasPending = vi.fn(() => Promise.resolve(true));
    const { flow } = flowWith(newcomerFor(cfg), cfg, { invitations: { hasPending } });
    const result = await flow.verifyEmailCode(browser(), { challenge: challengeArg, code: RIGHT });
    expect(result.ok).toBe(true);
    expect(hasPending).toHaveBeenCalledWith(ADDRESS);
  });
});

describe('verify refusals', () => {
  it('refuses a consumed challenge as a wrong code, with no attempt spent', async () => {
    const { flow, scripted } = flowWith(
      emailResponder({ challenge: { ...challengeRow(), consumed: true } }),
    );
    const result = await flow.verifyEmailCode(browser(), { challenge: challengeArg, code: RIGHT });
    expect(!result.ok && result.error.code).toBe('AUTH_CODE_INVALID');
    expect(scripted.writes()).toHaveLength(0);
  });

  it('refuses a challenge past its time or its five attempts as expired, before counting', async () => {
    const { flow, scripted, limiter } = flowWith(
      emailResponder({ challenge: challengeRow({ live: false }) }),
    );
    const result = await flow.verifyEmailCode(browser(), { challenge: challengeArg, code: RIGHT });
    expect(!result.ok && result.error.code).toBe('AUTH_CHALLENGE_EXPIRED');
    expect((limiter.reserve as Mock).mock.calls).toHaveLength(0);
    expect(scripted.writes()).toHaveLength(0);
  });

  it('answers expired when another request took the fifth attempt first', async () => {
    const row = challengeRow();
    const { flow } = flowWith((s) => (on(s, 'select', 'email_challenges') ? [row] : []));
    const result = await flow.verifyEmailCode(browser(), { challenge: challengeArg, code: RIGHT });
    expect(!result.ok && result.error.code).toBe('AUTH_CHALLENGE_EXPIRED');
  });

  it('answers a wrong code when the consume lost a race', async () => {
    const row = challengeRow({ codeHmac: codeHmac(RIGHT) });
    let updates = 0;
    const { flow } = flowWith((s) => {
      if (on(s, 'select', 'email_challenges')) return [row];
      if (on(s, 'update', 'email_challenges')) return (updates += 1) === 1 ? [row] : [];
      return [];
    });
    const result = await flow.verifyEmailCode(browser(), { challenge: challengeArg, code: RIGHT });
    expect(!result.ok && result.error.code).toBe('AUTH_CODE_INVALID');
  });

  it('refuses a malformed challenge id without a statement', async () => {
    const { flow, scripted } = flowWith(emailResponder());
    const result = await flow.verifyEmailCode(browser(), { challenge: 'nope', code: RIGHT });
    expect(!result.ok && result.error.code).toBe('AUTH_CODE_INVALID');
    expect(scripted.statements()).toHaveLength(0);
  });

  it('passes a database failure on as AUTH_UNAVAILABLE', async () => {
    const { flow } = flowWith(() => {
      throw new Error('down');
    });
    const result = await flow.verifyEmailCode(browser(), { challenge: challengeArg, code: RIGHT });
    expect(!result.ok && result.error.code).toBe('AUTH_UNAVAILABLE');
  });
});

describe('start', () => {
  it('uses the device allowance instead of the ceiling for a device known for the user', async () => {
    const device = Buffer.alloc(32, 8);
    const base = emailResponder();
    const { flow, limiter } = flowWith((s) =>
      on(s, 'select', 'known_devices') ? [{ user_id: USER }] : base(s),
    );
    const b = browser();
    const cookies = new Map(b.cookies);
    cookies.set(config.cookies.device, encodeSecret(device));
    await flow.startEmailSignIn({ ...b, cookies }, { email: ADDRESS });
    const calls = (limiter.reserve as Mock).mock.calls;
    expect(calls).toContainEqual(['email_send_device', [ADDRESS, sha256(device)]]);
    expect(calls.map(([bucket]) => bucket as string)).not.toContain('email_send_address_ceiling');
  });

  it('keeps a safe returnTo on the challenge', async () => {
    const { flow, scripted } = flowWith(emailResponder());
    await flow.startEmailSignIn(browser(), { email: ADDRESS, returnTo: '/acme/docs' });
    const insert = scripted.writes().find((s) => on(s, 'insert', 'email_challenges'));
    expect(insert?.parameters).toContain('/acme/docs');
  });

  it('stores the challenge but mails nobody for an unknown address in closed mode', async () => {
    const closed = withMode('closed');
    const { flow, scripted, mail } = flowWith(emailResponder({ known: false }), closed);
    const result = await flow.startEmailSignIn(browser(), { email: ADDRESS });
    if (!result.ok) throw result.error;
    await result.value.send();
    expect(mail.calls).toHaveLength(0);
    expect(scripted.writes().some((s) => on(s, 'insert', 'email_challenges'))).toBe(true);
  });
});

describe('the code issuer', () => {
  const issuerFor = (responder: Responder) => {
    const scripted = scriptedStore(responder);
    const { logger } = recordingLogger();
    return createCodeIssuer(config, {
      store: scripted.store,
      logger,
      mailer: { sendSignInCode: () => Promise.resolve() },
    });
  };

  it('refuses an address the address rule refuses', async () => {
    const result = await issuerFor(() => []).issue(browser(), {
      purpose: 'sign_in',
      email: 'not an address',
      userId: null,
    });
    expect(!result.ok && result.error.code).toBe('AUTH_INPUT_INVALID');
  });

  it('turns a database failure into AUTH_UNAVAILABLE', async () => {
    const result = await issuerFor(() => {
      throw new Error('down');
    }).issue(browser(), { purpose: 'sign_in', email: ADDRESS, userId: null });
    expect(!result.ok && result.error.code).toBe('AUTH_UNAVAILABLE');
  });
});

describe('verifyLinkCode', () => {
  const stepUpRow = (s: Parameters<Responder>[0]) =>
    on(s, 'select', 'email_challenges') ? [{ purpose: 'step_up' }] : [];

  it('refuses a malformed challenge before any statement', async () => {
    const { flow, scripted } = flowWith(emailResponder());
    const result = await flow.verifyLinkCode(browser(), null, { challenge: 'x', code: RIGHT });
    expect(!result.ok && result.error.code).toBe('AUTH_CODE_INVALID');
    expect(scripted.statements()).toHaveLength(0);
  });

  it('hands a step up code to the step up check of the signed in session', async () => {
    const stepped: SessionInfo = { ...session, stepUpMethod: 'email' };
    const verifyStepUpCode = vi.fn(() => Promise.resolve({ ok: true as const, value: stepped }));
    const t = unitDeps(stepUpRow);
    const flow = createEmailSignIn(config, {
      ...t.deps,
      sessions: { ...t.sessions, verifyStepUpCode },
    });
    const result = await flow.verifyLinkCode(browser(), session, {
      challenge: challengeArg,
      code: RIGHT,
    });
    expect(result).toEqual({ ok: true, value: { kind: 'stepped_up', session: stepped } });
    expect(t.sessions.startSession).not.toHaveBeenCalled();
  });

  it('passes a step up refusal through unchanged', async () => {
    const refusal = { ok: false as const, error: new AuthError('AUTH_CODE_INVALID') };
    const verifyStepUpCode = vi.fn(() => Promise.resolve(refusal));
    const t = unitDeps(stepUpRow);
    const flow = createEmailSignIn(config, {
      ...t.deps,
      sessions: { ...t.sessions, verifyStepUpCode },
    });
    const result = await flow.verifyLinkCode(browser(), session, {
      challenge: challengeArg,
      code: RIGHT,
    });
    expect(result).toBe(refusal);
  });

  it('refuses a step up code without a session, and without a step up check', async () => {
    const { flow } = flowWith(stepUpRow);
    const signedOut = await flow.verifyLinkCode(browser(), null, {
      challenge: challengeArg,
      code: RIGHT,
    });
    expect(!signedOut.ok && signedOut.error.code).toBe('AUTH_CHALLENGE_BINDING');
    const noCheck = await flow.verifyLinkCode(browser(), session, {
      challenge: challengeArg,
      code: RIGHT,
    });
    expect(!noCheck.ok && noCheck.error.code).toBe('AUTH_UNAVAILABLE');
  });

  it('signs in from a sign in code, and passes its refusal through', async () => {
    const row = challengeRow({ codeHmac: codeHmac(RIGHT) });
    const { flow } = flowWith((s) =>
      on(s, 'select', 'email_challenges') || on(s, 'update', 'email_challenges')
        ? [{ ...row, purpose: 'sign_in' }]
        : [],
    );
    const result = await flow.verifyLinkCode(browser(), null, {
      challenge: challengeArg,
      code: RIGHT,
    });
    expect(result.ok && result.value.kind).toBe('signed_in');
    const wrong = await flow.verifyLinkCode(browser(), null, {
      challenge: challengeArg,
      code: '11111111',
    });
    expect(!wrong.ok && wrong.error.code).toBe('AUTH_CODE_INVALID');
  });

  it('passes a database failure on as AUTH_UNAVAILABLE', async () => {
    const { flow } = flowWith(() => {
      throw new Error('down');
    });
    const result = await flow.verifyLinkCode(browser(), null, {
      challenge: challengeArg,
      code: RIGHT,
    });
    expect(!result.ok && result.error.code).toBe('AUTH_UNAVAILABLE');
  });
});

describe('construction', () => {
  it('builds its own store, limiter and sessions from the two databases', () => {
    const db = {} as unknown as Database;
    const authDb = {} as unknown as AuthDatabase;
    const { logger } = recordingLogger();
    expect(() =>
      createEmailSignIn(config, {
        db,
        authDb,
        logger,
        mailer: { sendSignInCode: () => Promise.resolve() },
        metrics: { increment: () => undefined },
      }),
    ).not.toThrow();
  });

  it('refuses to start without databases or the parts they would make', () => {
    const { logger } = recordingLogger();
    expect(() =>
      createEmailSignIn(config, { logger, mailer: { sendSignInCode: () => Promise.resolve() } }),
    ).toThrow(TypeError);
  });
});

describe('recordDevice', () => {
  it('never fails the sign in when the device cannot be written, and logs the user id only', async () => {
    const scripted = scriptedStore(() => {
      throw new Error(`down for ${ADDRESS}`);
    });
    const { logger, logs } = recordingLogger();
    const cookies = await recordDevice(config, { store: scripted.store, logger }, browser(), USER);
    expect(cookies).toEqual({ setCookies: [], newDevice: null });
    expect(logs.map((l) => l.event)).toEqual(['auth.device_record_failed']);
    expect(JSON.stringify(logs)).not.toContain(ADDRESS);
  });

  it('refreshes a held device without issuing a new cookie', async () => {
    const scripted = scriptedStore(() => []);
    const { logger } = recordingLogger();
    const b = browser();
    const cookies = new Map(b.cookies);
    cookies.set(config.cookies.device, encodeSecret(Buffer.alloc(32, 3)));
    const set = await recordDevice(
      config,
      { store: scripted.store, logger },
      { ...b, cookies },
      USER,
    );
    expect(set).toEqual({ setCookies: [], newDevice: null });
    const insert = scripted.writes().find((s) => on(s, 'insert', 'known_devices'));
    expect(insert?.parameters).toContainEqual(sha256(Buffer.alloc(32, 3)));
    expect(insert?.sql).toMatch(/on conflict \("user_id", "device_hash"\) do update set/);
  });
});

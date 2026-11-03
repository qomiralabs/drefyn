import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  AuthError,
  createEmailSignIn,
  createPasswordAccount,
  encodeSecret,
  formatChallengeId,
  parseAuthConfig,
  sha256,
  type AuthConfig,
  type AuthLogger,
  type PasswordAccountSessions,
  type RateLimiter,
} from '../src/index.ts';
import { createTestAuthMailer } from '../src/testing.ts';
import { scriptedStore, type Responder, type Statement } from './scripted-store.ts';
import {
  ADDRESS,
  CHALLENGE,
  PRE,
  USER,
  browser,
  challengeRow,
  config,
  fakeLimiter,
  on,
  session,
} from './email-fixtures.ts';
import { spyHasher } from './password-sign-in-fixtures.ts';
import { smallHasher } from './password-fixtures.ts';
import { validEnv } from './support.ts';

const RIGHT = '48312097';
const NEW_PASSWORD = 'a fresh and quiet sentence';
const OLD_PASSWORD = 'the old and quiet sentence';
const CHANGED_AT = new Date('2026-11-03T09:30:00.000Z');
const challengeArg = formatChallengeId(CHALLENGE);
const codeHmac = (code: string) => config.keys.mac('code', [CHALLENGE, 'password_reset', code]);

interface Script {
  readonly known?: boolean;
  readonly challenge?: Record<string, unknown> | null;
  readonly attempt?: 'row' | 'none';
  readonly consumed?: boolean;
  readonly phc?: string | null;
  readonly swapped?: boolean;
  readonly sessionLive?: boolean;
  readonly identities?: number;
  readonly removed?: boolean;
  readonly broken?: string;
}

function responder(script: Script = {}): Responder {
  const challenge =
    script.challenge === undefined
      ? challengeRow({ purpose: 'password_reset', codeHmac: codeHmac(RIGHT) })
      : script.challenge;
  return (s) => {
    if (script.broken !== undefined && s.sql.includes(script.broken)) {
      throw new Error(`connection reset for ${ADDRESS}`);
    }
    if (on(s, 'select', 'users')) return script.known === false ? [] : [{ id: USER }];
    if (on(s, 'select', 'known_devices')) return [];
    if (on(s, 'select', 'email_challenges')) return challenge === null ? [] : [challenge];
    if (on(s, 'update', 'email_challenges')) {
      if (s.sql.includes('"consumed_at" =')) {
        return script.consumed === false ? [] : [{ id: CHALLENGE }];
      }
      return script.attempt === 'none' || challenge === null ? [] : [challenge];
    }
    if (on(s, 'select', 'password_credentials')) {
      return script.phc === null ? [] : [{ phc: script.phc ?? 'stored-phc' }];
    }
    if (on(s, 'insert', 'password_credentials') || on(s, 'update', 'password_credentials')) {
      return script.swapped === false ? [] : [{ updated_at: CHANGED_AT }];
    }
    if (on(s, 'delete', 'password_credentials')) {
      return script.removed === false ? [] : [{ at: CHANGED_AT }];
    }
    if (on(s, 'select', 'sessions')) {
      return script.sessionLive === false ? [] : [{ id: session.sessionId }];
    }
    if (on(s, 'delete', 'sessions')) return [{ id: 'a' }, { id: 'b' }];
    if (on(s, 'select', 'identities')) {
      return Array.from({ length: script.identities ?? 0 }, (_, i) => ({ id: String(i) }));
    }
    return [];
  };
}

function recordingLogger() {
  const logs: { level: string; event: string; fields: Readonly<Record<string, unknown>> }[] = [];
  const logger: AuthLogger = {
    info(event, fields) {
      logs.push({ level: 'info', event, fields });
    },
    warn(event, fields) {
      logs.push({ level: 'warn', event, fields });
    },
  };
  return { logger, logs };
}

const fakeSessions = (recent = true) => ({
  startSession: vi.fn<PasswordAccountSessions['startSession']>(() =>
    Promise.resolve({
      session,
      setCookies: [{ name: config.cookies.session, value: 'v1.x', maxAgeSeconds: 60 }],
    }),
  ),
  requireRecentAuth: vi.fn<PasswordAccountSessions['requireRecentAuth']>(() =>
    Promise.resolve(
      recent
        ? { ok: true as const, value: undefined }
        : { ok: false as const, error: new AuthError('AUTH_RECENT_AUTH_REQUIRED') },
    ),
  ),
});

function setup(
  script: Script = {},
  options: {
    readonly config?: AuthConfig;
    readonly recent?: boolean;
    readonly refuse?: (bucket: string) => boolean;
    readonly verifies?: boolean;
  } = {},
) {
  const scripted = scriptedStore(responder(script));
  const mail = createTestAuthMailer();
  const limiter = fakeLimiter(options.refuse);
  const { logger, logs } = recordingLogger();
  const sessions = fakeSessions(options.recent ?? true);
  const inner = smallHasher();
  const spy = spyHasher(
    {
      hash: (p) => inner.hash(p),
      verify: (phc, p) => inner.verify(phc, p),
      check: async (phc, p) => ({
        ...(await inner.check(null, p)),
        matched: phc !== null && options.verifies !== false,
        rehash: false,
      }),
    },
    () => scripted.open,
  );
  const account = createPasswordAccount(options.config ?? config, {
    store: scripted.store,
    limiter,
    logger,
    mailer: mail.mailer,
    sessions,
    hasher: spy.hasher,
    random: (n) => new Uint8Array(n).fill(7),
  });
  return { account, scripted, mail, limiter, logs, sessions, spy };
}

const callsOf = (limiter: RateLimiter) =>
  (limiter.reserve as Mock<(bucket: string, value: readonly unknown[]) => Promise<void>>).mock
    .calls;
const writesTo = (statements: readonly Statement[], table: string) =>
  statements.filter(
    (s) => /^\s*(insert|update|delete)\b/i.test(s.sql) && s.sql.includes(`"${table}"`),
  );
const off = parseAuthConfig({ ...validEnv(), DREFYN_AUTH_PASSWORDS: 'off' });
const emailOff = parseAuthConfig({ ...validEnv(), DREFYN_AUTH_EMAIL: 'off' });
const codeOf = (r: { ok: boolean; error?: AuthError }) => (r.ok ? 'ok' : r.error?.code);

describe('startPasswordReset', () => {
  it('sends the same statements, cookies and limits for a known and an unknown address', async () => {
    const known = setup({ known: true });
    const unknown = setup({ known: false });
    const a = await known.account.startPasswordReset(browser(), { email: ADDRESS });
    const b = await unknown.account.startPasswordReset(browser(), { email: ADDRESS });
    if (!a.ok || !b.ok) throw new Error('refused');
    expect(a.value.setCookies).toEqual(b.value.setCookies);
    expect(Object.keys(a.value).sort()).toEqual(Object.keys(b.value).sort());
    const shape = (st: readonly Statement[]) => st.map((s) => s.sql);
    expect(shape(known.scripted.statements())).toEqual(shape(unknown.scripted.statements()));
    expect(callsOf(known.limiter).map((c) => c[0])).toEqual([
      'email_send',
      'email_send_ip',
      'email_send_address_ceiling',
    ]);
    expect(callsOf(unknown.limiter).map((c) => c[0])).toEqual(
      callsOf(known.limiter).map((c) => c[0]),
    );
    await a.value.send();
    await b.value.send();
    expect(known.mail.sent.map((m) => [m.to, m.purpose])).toEqual([[ADDRESS, 'password_reset']]);
    expect(unknown.mail.calls).toEqual([]);
  });

  it('stores an ownerless code for an unknown address', async () => {
    const unknown = setup({ known: false });
    await unknown.account.startPasswordReset(browser(), { email: ADDRESS });
    const insert = writesTo(unknown.scripted.statements(), 'email_challenges').find((s) =>
      /^\s*insert/i.test(s.sql),
    );
    expect(insert?.parameters).toContain('password_reset');
    expect(insert?.parameters).toContain(null);
  });

  it('uses the device allowance for a known device instead of the ceiling', async () => {
    const scripted = scriptedStore((s) => {
      if (on(s, 'select', 'users')) return [{ id: USER }];
      if (on(s, 'select', 'known_devices')) return [{ user_id: USER }];
      return [];
    });
    const limiter = fakeLimiter();
    const account = createPasswordAccount(config, {
      store: scripted.store,
      limiter,
      logger: recordingLogger().logger,
      mailer: createTestAuthMailer().mailer,
      sessions: fakeSessions(),
      hasher: smallHasher(),
    });
    const b = browser();
    const cookies = new Map(b.cookies);
    cookies.set(config.cookies.device, encodeSecret(Buffer.alloc(32, 3)));
    const result = await account.startPasswordReset({ ...b, cookies }, { email: ADDRESS });
    expect(result.ok).toBe(true);
    expect(callsOf(limiter).map((c) => c[0])).toContain('email_send_device');
    expect(callsOf(limiter).map((c) => c[0])).not.toContain('email_send_address_ceiling');
  });

  it('refuses a malformed address, a full bucket and disabled passwords', async () => {
    expect(codeOf(await setup().account.startPasswordReset(browser(), { email: 'not mail' }))).toBe(
      'AUTH_INPUT_INVALID',
    );
    expect(
      codeOf(
        await setup({}, { refuse: (b) => b === 'email_send' }).account.startPasswordReset(
          browser(),
          { email: ADDRESS },
        ),
      ),
    ).toBe('AUTH_RATE_LIMITED');
    const disabled = setup({}, { config: off });
    expect(codeOf(await disabled.account.startPasswordReset(browser(), { email: ADDRESS }))).toBe(
      'AUTH_PASSWORDS_DISABLED',
    );
    expect(disabled.scripted.statements()).toEqual([]);
  });

  it('answers unavailable when the database is down', async () => {
    const t = setup({ broken: '"users"' });
    expect(codeOf(await t.account.startPasswordReset(browser(), { email: ADDRESS }))).toBe(
      'AUTH_UNAVAILABLE',
    );
  });
});

describe('completePasswordReset', () => {
  const input = { challenge: challengeArg, code: RIGHT, newPassword: NEW_PASSWORD };

  it('writes the hash, ends every session, starts a fresh one and mails a notice', async () => {
    const t = setup();
    const result = await t.account.completePasswordReset(browser(), input);
    if (!result.ok) throw result.error;
    const statements = t.scripted.statements();
    const credential = writesTo(statements, 'password_credentials');
    expect(credential).toHaveLength(1);
    expect(credential[0]?.sql).toMatch(/on conflict \("user_id"\) do update set/);
    const ended = writesTo(statements, 'sessions');
    expect(ended).toHaveLength(1);
    expect(ended[0]?.sql).not.toContain('<>');
    expect(writesTo(statements, 'known_devices').map((s) => s.sql.trim().split(' ')[0])).toEqual([
      'delete',
      'insert',
    ]);
    expect(t.sessions.startSession).toHaveBeenCalledTimes(1);
    expect(t.sessions.startSession.mock.calls[0]?.[1]).toEqual({ userId: USER, method: 'email' });
    expect(result.value.setCookies.map((c) => c.name)).toEqual([
      config.cookies.session,
      config.cookies.device,
    ]);
    // The hash ran with no transaction open.
    expect(t.spy.calls.filter((c) => c.kind === 'hash').map((c) => c.open)).toEqual([0]);
    expect(t.mail.notices).toEqual([]);
    await result.value.send?.();
    expect(t.mail.notices).toEqual([
      { to: session.email, notice: { kind: 'password_reset', at: CHANGED_AT } },
    ]);
    expect(JSON.stringify(t.logs)).not.toContain(NEW_PASSWORD);
    expect(JSON.stringify(t.logs)).not.toContain(RIGHT);
    expect(t.logs.map((l) => l.event)).toContain('auth.password_reset');
  });

  it('refuses a code from another browser before counting anything', async () => {
    const t = setup({
      challenge: challengeRow({
        purpose: 'password_reset',
        codeHmac: codeHmac(RIGHT),
        browserHash: sha256(Buffer.alloc(32, 1)),
      }),
    });
    expect(codeOf(await t.account.completePasswordReset(browser(), input))).toBe(
      'AUTH_CHALLENGE_BINDING',
    );
    expect(t.scripted.writes()).toEqual([]);
    expect(callsOf(t.limiter)).toEqual([]);
    expect(t.spy.calls).toEqual([]);
  });

  it('refuses a browser with no pre sign in cookie before any read', async () => {
    const t = setup();
    expect(codeOf(await t.account.completePasswordReset(browser(null), input))).toBe(
      'AUTH_CHALLENGE_BINDING',
    );
    expect(t.scripted.statements()).toEqual([]);
  });

  it('refuses a weak password before spending an attempt, and names the rule', async () => {
    const t = setup();
    const result = await t.account.completePasswordReset(browser(), {
      ...input,
      newPassword: 'aaaaaaaaaaaaaaaaaaaa',
    });
    expect(!result.ok && result.error.code).toBe('AUTH_PASSWORD_WEAK');
    expect(!result.ok && result.error.rules?.length).toBeGreaterThan(0);
    expect(t.scripted.writes()).toEqual([]);
  });

  it('a wrong code counts an attempt, writes no password and starts no session', async () => {
    const t = setup();
    const result = await t.account.completePasswordReset(browser(), { ...input, code: '11111111' });
    expect(codeOf(result)).toBe('AUTH_CODE_INVALID');
    expect(writesTo(t.scripted.statements(), 'email_challenges')).toHaveLength(1);
    expect(writesTo(t.scripted.statements(), 'password_credentials')).toEqual([]);
    expect(t.sessions.startSession).not.toHaveBeenCalled();
    expect(t.spy.calls).toEqual([]);
  });

  it('a code another tab spent during the hash saves nothing', async () => {
    const t = setup({ consumed: false });
    expect(codeOf(await t.account.completePasswordReset(browser(), input))).toBe(
      'AUTH_CODE_INVALID',
    );
    expect(writesTo(t.scripted.statements(), 'password_credentials')).toEqual([]);
    expect(t.sessions.startSession).not.toHaveBeenCalled();
  });

  it('refuses spent, expired, raced, missing and ownerless challenges', async () => {
    const run = (script: Script) =>
      setup(script).account.completePasswordReset(browser(), input).then(codeOf);
    expect(
      await run({ challenge: { ...challengeRow({ purpose: 'password_reset' }), consumed: true } }),
    ).toBe('AUTH_CODE_INVALID');
    expect(await run({ challenge: challengeRow({ purpose: 'password_reset', live: false }) })).toBe(
      'AUTH_CHALLENGE_EXPIRED',
    );
    expect(await run({ attempt: 'none' })).toBe('AUTH_CHALLENGE_EXPIRED');
    expect(await run({ challenge: null })).toBe('AUTH_CODE_INVALID');
    expect(
      await run({
        challenge: challengeRow({
          purpose: 'password_reset',
          userId: null,
          codeHmac: codeHmac(RIGHT),
        }),
      }),
    ).toBe('AUTH_CODE_INVALID');
  });

  it('refuses malformed codes and challenge ids before any read', async () => {
    const t = setup();
    for (const bad of [
      { ...input, code: 'abc' },
      { ...input, challenge: 'nope' },
    ]) {
      expect(codeOf(await t.account.completePasswordReset(browser(), bad))).toBe(
        'AUTH_CODE_INVALID',
      );
    }
    expect(t.scripted.statements()).toEqual([]);
  });

  it('without a challenge id takes the newest open reset of this browser', async () => {
    const t = setup();
    const result = await t.account.completePasswordReset(browser(), {
      code: '4831 2097',
      newPassword: NEW_PASSWORD,
    });
    expect(result.ok).toBe(true);
    const read = t.scripted.statements().find((s) => on(s, 'select', 'email_challenges'));
    expect(read?.parameters).toContainEqual(sha256(PRE));
    expect(read?.sql).toMatch(/order by "created_at" desc/);
  });

  it('a full verify bucket refuses before the attempt', async () => {
    const t = setup({}, { refuse: (b) => b === 'code_verify' });
    expect(codeOf(await t.account.completePasswordReset(browser(), input))).toBe(
      'AUTH_RATE_LIMITED',
    );
    expect(t.scripted.writes()).toEqual([]);
  });

  it('is off with passwords, and refuses an oversized password', async () => {
    const disabled = setup({}, { config: off });
    expect(codeOf(await disabled.account.completePasswordReset(browser(), input))).toBe(
      'AUTH_PASSWORDS_DISABLED',
    );
    const huge = await setup().account.completePasswordReset(browser(), {
      ...input,
      newPassword: 'x'.repeat(5000),
    });
    expect(codeOf(huge)).toBe('AUTH_INPUT_INVALID');
  });

  it('a notice that cannot be sent is logged without the address', async () => {
    const t = setup();
    const result = await t.account.completePasswordReset(browser(), input);
    if (!result.ok) throw result.error;
    t.mail.failNext();
    await result.value.send?.();
    expect(t.logs.map((l) => l.event)).toContain('auth.password_notice_failed');
    expect(JSON.stringify(t.logs)).not.toContain(ADDRESS);
  });
});

describe('changePassword', () => {
  it('without the current password needs a sign in within 15 minutes', async () => {
    const t = setup({}, { recent: false });
    const result = await t.account.changePassword(browser(), session, {
      newPassword: NEW_PASSWORD,
    });
    expect(codeOf(result)).toBe('AUTH_RECENT_AUTH_REQUIRED');
    expect(t.scripted.writes()).toEqual([]);
    expect(t.spy.calls).toEqual([]);
  });

  it('with the current password works outside 15 minutes, counted like a sign in', async () => {
    const t = setup({}, { recent: false });
    const result = await t.account.changePassword(browser(), session, {
      currentPassword: OLD_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    if (!result.ok) throw result.error;
    expect(callsOf(t.limiter).map((c) => c[0])).toEqual(['password_fail', 'password_fail_ip']);
    expect(t.sessions.requireRecentAuth).not.toHaveBeenCalled();
    expect(t.spy.calls.map((c) => [c.kind, c.open])).toEqual([
      ['check', 0],
      ['hash', 0],
    ]);
  });

  it('swaps the hash only from the one read, ends the other sessions and mails a notice', async () => {
    const t = setup();
    const result = await t.account.changePassword(browser(), session, {
      newPassword: NEW_PASSWORD,
    });
    if (!result.ok) throw result.error;
    const statements = t.scripted.statements();
    const update = writesTo(statements, 'password_credentials')[0];
    expect(update?.sql).toMatch(/^\s*update/);
    expect(update?.parameters).toContain('stored-phc');
    const ended = writesTo(statements, 'sessions')[0];
    expect(ended?.sql).toContain('<>');
    expect(ended?.parameters).toContain(session.sessionId);
    expect(result.value.revoked).toBe(2);
    expect(result.value.setCookies.map((c) => c.name)).toEqual([config.cookies.device]);
    await result.value.send();
    expect(t.mail.notices).toEqual([
      { to: session.email, notice: { kind: 'password_changed', at: CHANGED_AT } },
    ]);
  });

  it('a wrong current password changes nothing', async () => {
    const t = setup({}, { verifies: false });
    const result = await t.account.changePassword(browser(), session, {
      currentPassword: 'not the right sentence',
      newPassword: NEW_PASSWORD,
    });
    expect(codeOf(result)).toBe('AUTH_CREDENTIALS_INVALID');
    expect(t.scripted.writes()).toEqual([]);
  });

  it('with no stored password: a current one is refused like a wrong one, none is not found', async () => {
    const withCurrent = await setup({ phc: null }).account.changePassword(browser(), session, {
      currentPassword: OLD_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(codeOf(withCurrent)).toBe('AUTH_CREDENTIALS_INVALID');
    const none = await setup({ phc: null }).account.changePassword(browser(), session, {
      newPassword: NEW_PASSWORD,
    });
    expect(codeOf(none)).toBe('AUTH_NOT_FOUND');
  });

  it('a change another tab made during the hash wins, and this one ends no session', async () => {
    const t = setup({ swapped: false });
    const result = await t.account.changePassword(browser(), session, {
      newPassword: NEW_PASSWORD,
    });
    expect(codeOf(result)).toBe('AUTH_CREDENTIALS_INVALID');
    expect(writesTo(t.scripted.statements(), 'sessions')).toEqual([]);
    expect(t.scripted.events.at(-1)).toEqual({ kind: 'rollback' });
  });

  it('refuses a session that ended meanwhile', async () => {
    const t = setup({ sessionLive: false });
    const result = await t.account.changePassword(browser(), session, {
      newPassword: NEW_PASSWORD,
    });
    expect(codeOf(result)).toBe('AUTH_SESSION_INVALID');
    expect(writesTo(t.scripted.statements(), 'password_credentials')).toEqual([]);
  });

  it('runs the rules against the account address, and is off with passwords', async () => {
    const weak = await setup().account.changePassword(browser(), session, {
      newPassword: 'person person person',
    });
    expect(codeOf(weak)).toBe('AUTH_PASSWORD_WEAK');
    const disabled = await setup({}, { config: off }).account.changePassword(browser(), session, {
      newPassword: NEW_PASSWORD,
    });
    expect(codeOf(disabled)).toBe('AUTH_PASSWORDS_DISABLED');
    const huge = await setup().account.changePassword(browser(), session, {
      currentPassword: 'x'.repeat(5000),
      newPassword: NEW_PASSWORD,
    });
    expect(codeOf(huge)).toBe('AUTH_INPUT_INVALID');
  });

  it('a full password bucket refuses before any hash', async () => {
    const t = setup({}, { refuse: (b) => b === 'password_fail' });
    const result = await t.account.changePassword(browser(), session, {
      currentPassword: OLD_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(codeOf(result)).toBe('AUTH_RATE_LIMITED');
    expect(t.spy.calls).toEqual([]);
  });
});

describe('removePassword', () => {
  it('is refused when it would leave no way to sign in', async () => {
    const t = setup({ identities: 0 }, { config: emailOff });
    expect(codeOf(await t.account.removePassword(session))).toBe('AUTH_FORBIDDEN');
    expect(writesTo(t.scripted.statements(), 'password_credentials')).toHaveLength(0);
  });

  it('is allowed with a linked provider while email is off, and mails a notice', async () => {
    const t = setup({ identities: 1 }, { config: emailOff });
    const result = await t.account.removePassword(session);
    if (!result.ok) throw result.error;
    // The person's row is locked first, so a parallel unlink cannot also pass the check.
    const first = t.scripted.statements()[0];
    expect(first?.sql).toMatch(/from "users"[\s\S]*for no key update/);
    await result.value.send();
    expect(t.mail.notices).toEqual([
      { to: session.email, notice: { kind: 'password_removed', at: CHANGED_AT } },
    ]);
  });

  it('is allowed while email codes are on', async () => {
    expect(codeOf(await setup({ identities: 0 }).account.removePassword(session))).toBe('ok');
  });

  it('needs a sign in within 15 minutes, and answers not found with no password', async () => {
    expect(codeOf(await setup({}, { recent: false }).account.removePassword(session))).toBe(
      'AUTH_RECENT_AUTH_REQUIRED',
    );
    expect(codeOf(await setup({ removed: false }).account.removePassword(session))).toBe(
      'AUTH_NOT_FOUND',
    );
  });
});

describe('createPasswordAccount', () => {
  it('refuses to start without databases or the parts they would make', () => {
    expect(() =>
      createPasswordAccount(config, {
        logger: recordingLogger().logger,
        mailer: createTestAuthMailer().mailer,
      }),
    ).toThrow(TypeError);
  });
});

describe('the verify link for a reset code', () => {
  function linkFlow(browserHash?: Buffer) {
    const scripted = scriptedStore((s) =>
      on(s, 'select', 'email_challenges')
        ? [
            {
              purpose: 'password_reset',
              browser_hash: browserHash ?? sha256(PRE),
            },
          ]
        : [],
    );
    const sessions = fakeSessions();
    const signIn = createEmailSignIn(config, {
      store: scripted.store,
      logger: recordingLogger().logger,
      mailer: createTestAuthMailer().mailer,
      sessions,
      limiter: fakeLimiter(),
    });
    return { signIn, scripted, sessions };
  }

  it('opens the choose a password step without proving or spending the code', async () => {
    const t = linkFlow();
    const result = await t.signIn.verifyLinkCode(browser(), null, {
      challenge: challengeArg,
      code: RIGHT,
    });
    expect(result.ok && result.value).toEqual({ kind: 'choose_password' });
    expect(t.scripted.writes()).toEqual([]);
    expect(t.sessions.startSession).not.toHaveBeenCalled();
  });

  it('refuses the link in another browser', async () => {
    const t = linkFlow(sha256(Buffer.alloc(32, 1)));
    const result = await t.signIn.verifyLinkCode(browser(), null, {
      challenge: challengeArg,
      code: RIGHT,
    });
    expect(codeOf(result)).toBe('AUTH_CHALLENGE_BINDING');
  });
});

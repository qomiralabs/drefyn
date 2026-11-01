import * as crypto from 'node:crypto';
import type * as Crypto from 'node:crypto';
import { DbError } from '@drefyn/db';
import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  AuthError,
  createEmailChange,
  createEmailSignIn,
  encodeSecret,
  formatChallengeId,
  sha256,
  type AuthLogger,
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
import { OTHER_USER } from './session-fixtures.ts';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof Crypto>();
  return { ...actual, randomInt: vi.fn(actual.randomInt) };
});

const randomInt = crypto.randomInt as unknown as Mock<(min: number, max: number) => number>;

const NEW = 'new@example.com';
const RIGHT = '48312097';
const challengeArg = formatChallengeId(CHALLENGE);
const CHANGED_AT = new Date('2026-11-01T09:30:00.000Z');
const codeHmac = (code: string) => config.keys.mac('code', [CHALLENGE, 'email_change', code]);

interface Script {
  readonly recent?: boolean;
  readonly sessionGone?: boolean;
  readonly taken?: boolean;
  readonly challenge?: Record<string, unknown> | null;
  readonly updated?: 'row' | 'none' | 'unique' | 'broken';
  readonly sessionsDelete?: 'ok' | 'broken';
}

function responder(script: Script = {}): Responder {
  const challenge =
    script.challenge === undefined
      ? challengeRow({ purpose: 'email_change', codeHmac: codeHmac(RIGHT) })
      : script.challenge;
  const row = challenge === null ? null : { ...challenge, email_normalized: NEW };
  return (s) => {
    if (on(s, 'select', 'sessions')) {
      return script.sessionGone === true ? [] : [{ recent: script.recent ?? true }];
    }
    if (on(s, 'select', 'users')) return script.taken === true ? [{ id: OTHER_USER }] : [];
    if (on(s, 'select', 'email_challenges')) return row === null ? [] : [row];
    if (on(s, 'update', 'email_challenges')) return row === null ? [] : [row];
    if (on(s, 'update', 'users')) {
      if (script.updated === 'unique') throw new DbError('DB_UNIQUE_VIOLATION', 'unique');
      if (script.updated === 'broken') throw new Error('connection reset');
      return script.updated === 'none' ? [] : [{ id: USER, updated_at: CHANGED_AT }];
    }
    if (on(s, 'delete', 'sessions')) {
      if (script.sessionsDelete === 'broken') throw new Error('connection reset');
      return [{ id: 'a' }, { id: 'b' }];
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

function setup(script: Script = {}, refuse?: (bucket: string) => boolean) {
  const scripted = scriptedStore(responder(script));
  const mail = createTestAuthMailer();
  const limiter = fakeLimiter(refuse);
  const { logger, logs } = recordingLogger();
  const change = createEmailChange(config, {
    store: scripted.store,
    limiter,
    logger,
    mailer: mail.mailer,
  });
  return { change, scripted, mail, limiter, logs };
}

const sqlOf = (statements: readonly Statement[]) => statements.map((s) => s.sql);
const writesTo = (statements: readonly Statement[], table: string) =>
  statements.filter((s) => /^\s*(insert|update|delete)\b/i.test(s.sql) && s.sql.includes(table));

describe('startEmailChange', () => {
  it('needs a sign in within 15 minutes and touches nothing without one', async () => {
    const { change, scripted, limiter, mail } = setup({ recent: false });
    const result = await change.startEmailChange(browser(), session, { newEmail: NEW });
    expect(!result.ok && result.error.code).toBe('AUTH_RECENT_AUTH_REQUIRED');
    expect(scripted.writes()).toEqual([]);
    expect(limiter.reserve).not.toHaveBeenCalled();
    expect(mail.calls).toEqual([]);
  });

  it('refuses a session whose row is gone', async () => {
    const { change } = setup({ sessionGone: true });
    const result = await change.startEmailChange(browser(), session, { newEmail: NEW });
    expect(!result.ok && result.error.code).toBe('AUTH_SESSION_INVALID');
  });

  it('refuses an address that is not one before any read', async () => {
    const { change, scripted } = setup();
    const result = await change.startEmailChange(browser(), session, { newEmail: 'not mail' });
    expect(!result.ok && result.error.code).toBe('AUTH_INPUT_INVALID');
    expect(scripted.statements()).toEqual([]);
  });

  it('mails a code for the new address, bound to the browser and the user', async () => {
    const { change, scripted, mail } = setup();
    const result = await change.startEmailChange(browser(), session, { newEmail: NEW });
    if (!result.ok) throw result.error;
    expect(mail.calls).toEqual([]);
    await result.value.send();
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: NEW, purpose: 'email_change' });
    const insert = writesTo(scripted.statements(), 'email_challenges').find((s) =>
      /^\s*insert/i.test(s.sql),
    );
    expect(insert?.parameters).toEqual(
      expect.arrayContaining([NEW, 'email_change', USER, sha256(PRE)]),
    );
  });

  it('answers a taken address exactly like a free one, with the same statements and no mail', async () => {
    const free = setup({ taken: false });
    const taken = setup({ taken: true });
    const a = await free.change.startEmailChange(browser(), session, { newEmail: NEW });
    const b = await taken.change.startEmailChange(browser(), session, { newEmail: NEW });
    if (!a.ok || !b.ok) throw new Error('start failed');
    expect(Object.keys(a.value).sort()).toEqual(Object.keys(b.value).sort());
    expect(a.value.setCookies.map((c) => [c.name, c.maxAgeSeconds, c.value.length])).toEqual(
      b.value.setCookies.map((c) => [c.name, c.maxAgeSeconds, c.value.length]),
    );
    expect(sqlOf(free.scripted.statements())).toEqual(sqlOf(taken.scripted.statements()));
    expect(free.limiter.reserve).toHaveBeenCalledTimes(3);
    expect(vi.mocked(taken.limiter.reserve).mock.calls.map((c) => c[0])).toEqual(
      vi.mocked(free.limiter.reserve).mock.calls.map((c) => c[0]),
    );
    await a.value.send();
    await b.value.send();
    expect(free.mail.calls).toHaveLength(1);
    expect(taken.mail.calls).toEqual([]);
  });

  it('stores a code for a taken address that no typed code can ever match', async () => {
    for (const taken of [false, true]) {
      randomInt.mockReturnValueOnce(Number(RIGHT));
      const { change, scripted } = setup({ taken });
      const result = await change.startEmailChange(browser(), session, { newEmail: NEW });
      expect(result.ok).toBe(true);
      const insert = writesTo(scripted.statements(), 'email_challenges').find((s) =>
        /^\s*insert/i.test(s.sql),
      );
      const id = insert?.parameters.find(
        (p) => typeof p === 'string' && /^[0-9a-f-]{36}$/.test(p) && p !== USER,
      );
      const stored = insert?.parameters.find(
        (p): p is Buffer => Buffer.isBuffer(p) && !p.equals(sha256(PRE)),
      );
      if (typeof id !== 'string' || stored === undefined) throw new Error('no challenge stored');
      expect(config.keys.verify('code', [id, 'email_change', RIGHT], stored)).toBe(!taken);
    }
  });

  it('counts the send limits on the new address and refuses when they are spent', async () => {
    const { change, scripted, limiter } = setup({}, (bucket) => bucket === 'email_send');
    const result = await change.startEmailChange(browser(), session, { newEmail: NEW });
    expect(!result.ok && result.error.code).toBe('AUTH_RATE_LIMITED');
    expect(limiter.reserve).toHaveBeenCalledWith('email_send', [NEW, expect.any(Buffer)]);
    expect(writesTo(scripted.statements(), 'email_challenges')).toEqual([]);
  });

  it('answers unavailable when the database fails', async () => {
    const scripted = scriptedStore((s) => {
      if (on(s, 'select', 'sessions')) return [{ recent: true }];
      throw new Error('connection reset');
    });
    const change = createEmailChange(config, {
      store: scripted.store,
      limiter: fakeLimiter(),
      logger: recordingLogger().logger,
      mailer: createTestAuthMailer().mailer,
    });
    const result = await change.startEmailChange(browser(), session, { newEmail: NEW });
    expect(!result.ok && result.error.code).toBe('AUTH_UNAVAILABLE');
  });

  it('logs ids only, never an address', async () => {
    const { change, logs } = setup();
    const result = await change.startEmailChange(browser(), session, { newEmail: NEW });
    expect(result.ok).toBe(true);
    const text = JSON.stringify(logs);
    expect(text).not.toContain(NEW);
    expect(text).not.toContain(ADDRESS);
  });
});

describe('completeEmailChange', () => {
  const complete = (t: ReturnType<typeof setup>, code = RIGHT, b = browser()) =>
    t.change.completeEmailChange(b, session, { challenge: challengeArg, code });

  it('needs a sign in within 15 minutes and touches nothing without one', async () => {
    const t = setup({ recent: false });
    const result = await complete(t);
    expect(!result.ok && result.error.code).toBe('AUTH_RECENT_AUTH_REQUIRED');
    expect(t.scripted.writes()).toEqual([]);
    expect(t.limiter.reserve).not.toHaveBeenCalled();
  });

  it('runs the guarded update, clears the old address challenges and the other sessions', async () => {
    const t = setup();
    const result = await complete(t);
    if (!result.ok) throw result.error;
    const statements = t.scripted.statements();
    const update = writesTo(statements, '"users"')[0];
    expect(update?.sql).toMatch(/where "id" = \$\d+ and "email_normalized" = \$\d+/);
    expect(update?.parameters).toEqual(expect.arrayContaining([NEW, USER, ADDRESS]));
    const cleared = writesTo(statements, 'email_challenges').find((s) => /^\s*delete/i.test(s.sql));
    expect(cleared?.sql).toMatch(/"consumed_at" is null/);
    expect(cleared?.parameters).toEqual(expect.arrayContaining([USER, ADDRESS]));
    const others = writesTo(statements, '"sessions"')[0];
    expect(others?.sql).toMatch(/"id" <> \$\d+/);
    expect(others?.parameters).toContain(session.sessionId);
    // The update and the cleanup commit together, in one auth transaction.
    const beginUpdate = t.scripted.events.findIndex(
      (e) => e.kind === 'statement' && e.statement === update,
    );
    const beginClear = t.scripted.events.findIndex(
      (e) => e.kind === 'statement' && e.statement === cleared,
    );
    const between = t.scripted.events.slice(beginUpdate, beginClear);
    expect(between.some((e) => e.kind === 'commit' || e.kind === 'begin')).toBe(false);
  });

  it('sends the notice to the old address only when asked to, and never throws', async () => {
    const t = setup();
    const result = await complete(t);
    if (!result.ok) throw result.error;
    expect(t.mail.notices).toEqual([]);
    await result.value.send();
    expect(t.mail.notices).toEqual([
      { to: ADDRESS, notice: { kind: 'email_changed', newAddress: NEW, at: CHANGED_AT } },
    ]);
    t.mail.failNext();
    await expect(result.value.send()).resolves.toBeUndefined();
    expect(t.logs.some((l) => l.event === 'auth.email_change_notice_failed')).toBe(true);
  });

  it('logs ids and a count, never an address', async () => {
    const t = setup();
    const result = await complete(t);
    if (!result.ok) throw result.error;
    await result.value.send();
    const done = t.logs.find((l) => l.event === 'auth.email_changed');
    expect(done?.fields).toMatchObject({ revoked: 2 });
    const text = JSON.stringify(t.logs);
    expect(text).not.toContain(NEW);
    expect(text).not.toContain(ADDRESS);
  });

  it('gives the generic failure and changes nothing when the old address moved meanwhile', async () => {
    const t = setup({ updated: 'none' });
    const result = await complete(t);
    expect(!result.ok && result.error.code).toBe('AUTH_CODE_INVALID');
    expect(writesTo(t.scripted.statements(), '"sessions"')).toEqual([]);
    expect(t.scripted.events.at(-1)).toEqual({ kind: 'rollback' });
  });

  it('gives the same generic failure on a unique violation, a sign up that won the race', async () => {
    const t = setup({ updated: 'unique' });
    const result = await complete(t);
    expect(!result.ok && result.error.code).toBe('AUTH_CODE_INVALID');
    expect(writesTo(t.scripted.statements(), '"sessions"')).toEqual([]);
  });

  it('answers unavailable for any other failure of the update', async () => {
    const t = setup({ updated: 'broken' });
    const result = await complete(t);
    expect(!result.ok && result.error.code).toBe('AUTH_UNAVAILABLE');
  });

  it('keeps the change and says so in the log when the other sessions could not be removed', async () => {
    const t = setup({ sessionsDelete: 'broken' });
    const result = await complete(t);
    expect(result.ok).toBe(true);
    expect(t.logs.some((l) => l.event === 'auth.email_change_sessions_kept')).toBe(true);
  });

  it('refuses a wrong code with the generic failure and no update', async () => {
    const t = setup();
    const result = await complete(t, '00000000');
    expect(!result.ok && result.error.code).toBe('AUTH_CODE_INVALID');
    expect(writesTo(t.scripted.statements(), '"users"')).toEqual([]);
  });

  it('refuses malformed input before any read', async () => {
    const t = setup();
    const short = await complete(t, '123');
    const badId = await t.change.completeEmailChange(browser(), session, {
      challenge: 'nope',
      code: RIGHT,
    });
    expect(!short.ok && short.error.code).toBe('AUTH_CODE_INVALID');
    expect(!badId.ok && badId.error.code).toBe('AUTH_CODE_INVALID');
    expect(t.scripted.statements()).toEqual([]);
  });

  it('accepts the code with the gaps people type', async () => {
    const t = setup();
    const result = await complete(t, '4831 2097');
    expect(result.ok).toBe(true);
  });

  it('refuses without the browser binding, and from another browser, at no attempt', async () => {
    const t = setup();
    const none = await complete(t, RIGHT, browser(null));
    const other = await complete(t, RIGHT, browser(encodeSecret(Buffer.alloc(32, 7))));
    expect(!none.ok && none.error.code).toBe('AUTH_CHALLENGE_BINDING');
    expect(!other.ok && other.error.code).toBe('AUTH_CHALLENGE_BINDING');
    expect(writesTo(t.scripted.statements(), 'email_challenges')).toEqual([]);
  });

  it('looks the challenge up only among this user and this purpose', async () => {
    const t = setup();
    await complete(t);
    const read = t.scripted.statements().find((s) => on(s, 'select', 'email_challenges'));
    expect(read?.sql).toMatch(/"purpose" = \$\d+/);
    expect(read?.sql).toMatch(/"user_id" = \$\d+/);
    expect(read?.parameters).toEqual(expect.arrayContaining(['email_change', USER]));
  });

  it('uses the newest open challenge of this browser when no id is given', async () => {
    const t = setup();
    const result = await t.change.completeEmailChange(browser(), session, { code: RIGHT });
    expect(result.ok).toBe(true);
    const read = t.scripted.statements().find((s) => on(s, 'select', 'email_challenges'));
    expect(read?.sql).toMatch(/order by "created_at" desc/);
  });

  it('refuses a missing, consumed or expired challenge', async () => {
    const missing = await complete(setup({ challenge: null }));
    const consumed = await complete(
      setup({
        challenge: {
          ...challengeRow({ purpose: 'email_change', codeHmac: codeHmac(RIGHT) }),
          consumed: true,
        },
      }),
    );
    const expired = await complete(
      setup({
        challenge: challengeRow({
          purpose: 'email_change',
          codeHmac: codeHmac(RIGHT),
          live: false,
        }),
      }),
    );
    expect(!missing.ok && missing.error.code).toBe('AUTH_CODE_INVALID');
    expect(!consumed.ok && consumed.error.code).toBe('AUTH_CODE_INVALID');
    expect(!expired.ok && expired.error.code).toBe('AUTH_CHALLENGE_EXPIRED');
  });

  it('refuses a challenge that names another user', async () => {
    const t = setup({
      challenge: challengeRow({
        purpose: 'email_change',
        codeHmac: codeHmac(RIGHT),
        userId: OTHER_USER,
      }),
    });
    const result = await complete(t);
    expect(!result.ok && result.error.code).toBe('AUTH_CODE_INVALID');
    expect(writesTo(t.scripted.statements(), '"users"')).toEqual([]);
  });

  it('counts the attempt against the verify limit first', async () => {
    const t = setup({}, (bucket) => bucket === 'code_verify');
    const result = await complete(t);
    expect(!result.ok && result.error.code).toBe('AUTH_RATE_LIMITED');
    expect(t.limiter.reserve).toHaveBeenCalledWith('code_verify', [NEW, sha256(PRE)]);
    expect(writesTo(t.scripted.statements(), '"users"')).toEqual([]);
  });

  it('refuses when the counted attempt finds the challenge spent meanwhile', async () => {
    const scripted = scriptedStore((s) => {
      if (on(s, 'update', 'email_challenges')) return [];
      return responder()(s);
    });
    const change = createEmailChange(config, {
      store: scripted.store,
      limiter: fakeLimiter(),
      logger: recordingLogger().logger,
      mailer: createTestAuthMailer().mailer,
    });
    const result = await change.completeEmailChange(browser(), session, {
      challenge: challengeArg,
      code: RIGHT,
    });
    expect(!result.ok && result.error.code).toBe('AUTH_CHALLENGE_EXPIRED');
  });

  it('refuses when another request consumed the code first', async () => {
    let updates = 0;
    const scripted = scriptedStore((s) => {
      if (on(s, 'update', 'email_challenges')) {
        updates += 1;
        return updates === 1 ? (responder()(s) as Record<string, unknown>[]) : [];
      }
      return responder()(s);
    });
    const change = createEmailChange(config, {
      store: scripted.store,
      limiter: fakeLimiter(),
      logger: recordingLogger().logger,
      mailer: createTestAuthMailer().mailer,
    });
    const result = await change.completeEmailChange(browser(), session, {
      challenge: challengeArg,
      code: RIGHT,
    });
    expect(!result.ok && result.error.code).toBe('AUTH_CODE_INVALID');
  });
});

describe('the verify link', () => {
  function signInWith(emailChange?: { completeEmailChange: Mock }) {
    const scripted = scriptedStore((s) =>
      on(s, 'select', 'email_challenges') ? [{ purpose: 'email_change' }] : [],
    );
    return createEmailSignIn(config, {
      store: scripted.store,
      logger: recordingLogger().logger,
      mailer: createTestAuthMailer().mailer,
      limiter: fakeLimiter(),
      sessions: { startSession: vi.fn() },
      ...(emailChange === undefined ? {} : { emailChange }),
    });
  }

  it('hands an email change code to the change flow of the signed in session', async () => {
    const send = vi.fn(() => Promise.resolve());
    const completeEmailChange = vi.fn(() => Promise.resolve({ ok: true, value: { send } }));
    const flow = signInWith({ completeEmailChange });
    const input = { challenge: challengeArg, code: RIGHT };
    const result = await flow.verifyLinkCode(browser(), session, input);
    expect(result).toEqual({ ok: true, value: { kind: 'email_changed', send } });
    expect(completeEmailChange).toHaveBeenCalledWith(expect.anything(), session, input);
  });

  it('passes the change flow refusal through', async () => {
    const completeEmailChange = vi.fn(() =>
      Promise.resolve({ ok: false, error: new AuthError('AUTH_RECENT_AUTH_REQUIRED') }),
    );
    const flow = signInWith({ completeEmailChange });
    const result = await flow.verifyLinkCode(browser(), session, {
      challenge: challengeArg,
      code: RIGHT,
    });
    expect(!result.ok && result.error.code).toBe('AUTH_RECENT_AUTH_REQUIRED');
  });

  it('never signs anyone in with an email change code', async () => {
    const flow = signInWith({ completeEmailChange: vi.fn() });
    const result = await flow.verifyLinkCode(browser(), null, {
      challenge: challengeArg,
      code: RIGHT,
    });
    expect(!result.ok && result.error.code).toBe('AUTH_CHALLENGE_BINDING');
  });

  it('is unavailable when the change flow is not wired', async () => {
    const flow = signInWith();
    const result = await flow.verifyLinkCode(browser(), session, {
      challenge: challengeArg,
      code: RIGHT,
    });
    expect(!result.ok && result.error.code).toBe('AUTH_UNAVAILABLE');
  });
});

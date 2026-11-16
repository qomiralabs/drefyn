import { describe, expect, it, vi } from 'vitest';
import type { Statement } from './scripted-store.ts';
import { googleAccount } from './oauth-fakes.ts';
import {
  codeOf,
  identity,
  roundTrip,
  setup as oauthSetup,
  signedIn,
  user,
  writesTo,
} from './oauth-fixtures.ts';
import { USER, browser, capturingLogger, sessionInfo, setup } from './session-fixtures.ts';
import { recordStepUp } from '../src/step-up.ts';
import { formatChallengeId } from '../src/tokens.ts';
import { scriptedStore } from './scripted-store.ts';

const isFactorRead = (s: Statement) =>
  /^select\b/i.test(s.sql) &&
  s.sql.includes('from "totp_credentials"') &&
  s.sql.includes('"confirmed_at" is not null');
const isLock = (s: Statement) => s.sql.includes('pg_advisory_xact_lock_shared');
const isStepUpWrite = (s: Statement) =>
  /^update "sessions"/i.test(s.sql) && s.sql.includes('"step_up_method"');

// A person with a confirmed factor: the read that asks says so.
const enrolled = (s: Statement) => (isFactorRead(s) ? [{ user_id: USER }] : []);

const errorOf = (result: { ok: boolean; error?: { code: string } }) =>
  result.ok ? 'ok' : result.error?.code;

describe('once enrolled, the other step ups answer AUTH_FACTOR_REQUIRED', () => {
  it('password: refused before anything is counted or hashed', async () => {
    const verify = vi.fn(() => Promise.resolve(true));
    const { sessions, limiter, scripted } = setup(enrolled, { passwords: { verify } });
    const result = await sessions.stepUpWithPassword(browser(), sessionInfo(), { password: 'x' });
    expect(errorOf(result)).toBe('AUTH_FACTOR_REQUIRED');
    expect(limiter.calls).toEqual([]);
    expect(verify).not.toHaveBeenCalled();
    expect(scripted.writes()).toEqual([]);
  });

  it('email code: refused at start, with no challenge stored and no mail', async () => {
    const sendSignInCode = vi.fn(() => Promise.resolve());
    const { sessions, limiter, scripted } = setup(enrolled, { mailer: { sendSignInCode } });
    const result = await sessions.startStepUpCode(browser(), sessionInfo());
    expect(errorOf(result)).toBe('AUTH_FACTOR_REQUIRED');
    expect(limiter.calls).toEqual([]);
    expect(scripted.writes()).toEqual([]);
    expect(sendSignInCode).not.toHaveBeenCalled();
  });

  it('email code: refused at verify, so a code asked for before enrolment cannot finish', async () => {
    const { sessions, limiter, scripted, lines } = setup(enrolled);
    const result = await sessions.verifyStepUpCode(browser(), sessionInfo(), {
      challenge: formatChallengeId('01890a5d-ac96-774b-bcce-b302099a8070'),
      code: '12345678',
    });
    expect(errorOf(result)).toBe('AUTH_FACTOR_REQUIRED');
    expect(limiter.calls).toEqual([]);
    expect(scripted.writes()).toEqual([]);
    expect(lines.map((l) => l.event)).toContain('auth.step_up_failed');
  });

  // The start check passed before the enrolment; the record reads again under the lock.
  it('records no step up when the factor lands between the start and the write', async () => {
    let reads = 0;
    const scripted = scriptedStore((s) => {
      if (isFactorRead(s)) {
        reads += 1;
        return [{ user_id: USER }];
      }
      return [];
    });
    const { logger } = capturingLogger();
    await expect(
      recordStepUp(scripted.store, sessionInfo(), 'email', logger),
    ).rejects.toMatchObject({ code: 'AUTH_FACTOR_REQUIRED' });
    expect(reads).toBe(1);
    // The lock comes first, then the read, and nothing is written.
    const statements = scripted.statements();
    expect(statements.findIndex(isLock)).toBe(0);
    expect(statements.some(isStepUpWrite)).toBe(false);
  });

  it('a person with no factor still steps up as before, under the shared lock', async () => {
    const scripted = scriptedStore((s) =>
      isStepUpWrite(s) ? [{ authenticated_at: new Date('2026-11-16T10:00:00.000Z') }] : [],
    );
    const { logger } = capturingLogger();
    const stepped = await recordStepUp(scripted.store, sessionInfo(), 'email', logger);
    expect(stepped.stepUpMethod).toBe('email');
    const statements = scripted.statements();
    expect(statements.findIndex(isLock)).toBeLessThan(statements.findIndex(isFactorRead));
    expect(statements.findIndex(isFactorRead)).toBeLessThan(statements.findIndex(isStepUpWrite));
  });
});

describe('OAuth step up once enrolled', () => {
  it('is refused at start, before the round trip', async () => {
    const t = oauthSetup();
    const me = user(t, 'g-start@example.com');
    const { jar, session } = await signedIn(t, me);
    t.db.tables.totp_credentials.push({ user_id: me });
    const started = await t.oauth.startOAuth(jar.context(), {
      provider: 'google',
      purpose: 'step_up',
      session,
    });
    expect(codeOf(started)).toBe('AUTH_FACTOR_REQUIRED');
    expect(t.reserve).not.toHaveBeenCalled();
  });

  it('is refused at the callback when the factor landed meanwhile', async () => {
    const t = oauthSetup({ fakes: { authTimeAgoSeconds: 10 } });
    const email = 'g-late@example.com';
    const me = user(t, email);
    const account = googleAccount(email);
    identity(t, me, account);
    const first = await signedIn(t, me);
    const { done } = await roundTrip(t, account, {
      ...first,
      purpose: 'step_up',
      edit: () => {
        t.db.tables.totp_credentials.push({ user_id: me });
      },
    });
    expect(codeOf(done)).toBe('AUTH_FACTOR_REQUIRED');
    expect(writesTo(t, 'sessions').filter((s) => /^\s*update/i.test(s.sql))).toEqual([]);
    expect(JSON.stringify(t.logs)).toContain('auth.step_up_failed');
  });
});

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AuthError,
  breachedDigest,
  createPasswordSignIn,
  loadBreachedPasswords,
  type AuthMetricName,
  type BreachedPasswordCheck,
  type SessionInfo,
} from '../src/index.ts';
import { admitNewPassword } from '../src/new-password.ts';
import { on, recordingLogger } from './email-fixtures.ts';
import { smallHasher } from './password-fixtures.ts';
import {
  PASSWORD,
  config,
  configWith,
  csrfFor,
  passwordBrowser,
  passwordDeps,
  session,
} from './password-sign-in-fixtures.ts';

const BREACHED = 'a password everyone has used';
const FRESH = 'a brand new sentence';
const signedIn: SessionInfo = session;

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'drefyn-password-breached-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function listing(...passwords: string[]) {
  return vi.fn<BreachedPasswordCheck['isBreached']>((password) =>
    Promise.resolve(passwords.includes(password)),
  );
}

describe('setPassword and the breached list', () => {
  it('refuses a breached password with AUTH_PASSWORD_BREACHED and hashes and writes nothing', async () => {
    const isBreached = listing(BREACHED);
    const t = passwordDeps({ known: true, phc: null }, { breachedPasswords: { isBreached } });
    const result = await createPasswordSignIn(config, t.deps).setPassword(signedIn, {
      newPassword: BREACHED,
    });
    expect(!result.ok && result.error.code).toBe('AUTH_PASSWORD_BREACHED');
    expect(isBreached).toHaveBeenCalledTimes(1);
    expect(isBreached.mock.calls[0]?.[0]).toBe(BREACHED);
    expect(t.spy.calls).toEqual([]);
    expect(t.scripted.writes()).toEqual([]);
    const refusal = t.logs.find((l) => l.event === 'auth.password_refused');
    expect(refusal?.fields).toEqual({
      outcome: 'AUTH_PASSWORD_BREACHED',
      userId: expect.stringMatching(/^usr_/) as unknown,
    });
    expect(JSON.stringify(t.logs)).not.toContain(BREACHED);
  });

  it('accepts a password the list does not hold', async () => {
    const isBreached = listing(BREACHED);
    const t = passwordDeps({ known: true, phc: null }, { breachedPasswords: { isBreached } });
    const result = await createPasswordSignIn(config, t.deps).setPassword(signedIn, {
      newPassword: FRESH,
    });
    expect(result).toEqual({ ok: true, value: { send: expect.any(Function) } });
    expect(t.scripted.writes().some((s) => on(s, 'insert', 'password_credentials'))).toBe(true);
  });

  it('asks only after the built in rules and the recent sign in pass, so it is no oracle', async () => {
    const isBreached = listing(BREACHED);
    const weak = passwordDeps({ known: true, phc: null }, { breachedPasswords: { isBreached } });
    const tooWeak = await createPasswordSignIn(config, weak.deps).setPassword(signedIn, {
      newPassword: 'qwertyuiopasdfgh',
    });
    expect(!tooWeak.ok && tooWeak.error.code).toBe('AUTH_PASSWORD_WEAK');

    const stale = passwordDeps({ known: true, phc: null }, { breachedPasswords: { isBreached } });
    stale.sessions.requireRecentAuth.mockResolvedValueOnce({
      ok: false,
      error: new AuthError('AUTH_RECENT_AUTH_REQUIRED'),
    } as never);
    const notRecent = await createPasswordSignIn(config, stale.deps).setPassword(signedIn, {
      newPassword: BREACHED,
    });
    expect(!notRecent.ok && notRecent.error.code).toBe('AUTH_RECENT_AUTH_REQUIRED');
    expect(isBreached).not.toHaveBeenCalled();
  });

  it('a check that stalls accepts the password after the timeout and counts it', async () => {
    vi.useFakeTimers();
    try {
      const counted: AuthMetricName[] = [];
      const t = passwordDeps(
        { known: true, phc: null },
        {
          breachedPasswords: { isBreached: () => new Promise(() => undefined) },
          metrics: { increment: (name) => counted.push(name) },
        },
      );
      const pending = createPasswordSignIn(config, t.deps).setPassword(signedIn, {
        newPassword: BREACHED,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      vi.useRealTimers();
      await expect(pending).resolves.toEqual({ ok: true, value: { send: expect.any(Function) } });
      expect(counted).toEqual(['auth.breach_check_unavailable']);
      expect(t.logs.find((l) => l.event === 'auth.breach_check_unavailable')?.fields).toEqual({
        userId: expect.stringMatching(/^usr_/) as unknown,
        reason: 'timeout',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('is never asked at sign in, even for a password it would call breached', async () => {
    const isBreached = listing(PASSWORD);
    const hasher = smallHasher();
    const t = passwordDeps(
      { known: true, phc: await hasher.hash(PASSWORD) },
      { breachedPasswords: { isBreached } },
    );
    const result = await createPasswordSignIn(config, t.deps).signInWithPassword(
      passwordBrowser(),
      { email: 'person@example.com', password: PASSWORD, csrf: csrfFor(config) },
    );
    expect(result.ok).toBe(true);
    expect(isBreached).not.toHaveBeenCalled();
  });
});

describe('the breached list from config', () => {
  it('uses the check opened at startup from DREFYN_AUTH_BREACHED_PASSWORDS_FILE', async () => {
    const path = join(dir, 'configured.bin');
    await writeFile(path, breachedDigest(BREACHED));
    const withFile = configWith({ DREFYN_AUTH_BREACHED_PASSWORDS_FILE: path });
    const t = passwordDeps({ known: true, phc: null });
    const breachedPasswords = await loadBreachedPasswords(withFile, t.deps.logger);
    const flow = createPasswordSignIn(withFile, {
      ...t.deps,
      ...(breachedPasswords === undefined ? {} : { breachedPasswords }),
    });
    const refused = await flow.setPassword(signedIn, { newPassword: BREACHED });
    expect(!refused.ok && refused.error.code).toBe('AUTH_PASSWORD_BREACHED');
    const accepted = await flow.setPassword(signedIn, { newPassword: FRESH });
    expect(accepted.ok).toBe(true);
  });

  it('refuses to build with a configured file but no opened check, so the file is never skipped', async () => {
    const path = join(dir, 'never-opened.bin');
    await writeFile(path, breachedDigest(BREACHED));
    const withFile = configWith({ DREFYN_AUTH_BREACHED_PASSWORDS_FILE: path });
    expect(() => createPasswordSignIn(withFile, passwordDeps().deps)).toThrow(
      /loadBreachedPasswords/,
    );
  });

  it('a list file removed after startup accepts, logged and counted', async () => {
    const path = join(dir, 'removed-later.bin');
    await writeFile(path, breachedDigest(BREACHED));
    const withFile = configWith({ DREFYN_AUTH_BREACHED_PASSWORDS_FILE: path });
    const counted: AuthMetricName[] = [];
    const t = passwordDeps(
      { known: true, phc: null },
      { metrics: { increment: (name) => counted.push(name) } },
    );
    const breachedPasswords = await loadBreachedPasswords(withFile, t.deps.logger);
    // Truncated in place: the open handle now reads nothing where a record was.
    await writeFile(path, '');
    const flow = createPasswordSignIn(withFile, {
      ...t.deps,
      ...(breachedPasswords === undefined ? {} : { breachedPasswords }),
    });
    const result = await flow.setPassword(signedIn, { newPassword: BREACHED });
    expect(result.ok).toBe(true);
    expect(counted).toEqual(['auth.breach_check_unavailable']);
    expect(t.logs.find((l) => l.event === 'auth.breach_check_unavailable')?.fields).toMatchObject({
      reason: 'error',
    });
  });

  it('with no file, the built in rules still refuse their families', async () => {
    const t = passwordDeps({ known: true, phc: null });
    const flow = createPasswordSignIn(config, t.deps);
    const families: [string, string][] = [
      ['aaaaaaaaaaaaaaaaaa', 'repeated_character'],
      ['abcdefghijklmnopq', 'sequence'],
      ['qwertyuiopasdfgh', 'keyboard_walk'],
      ['abcxabcxabcxabcx', 'repeated_unit'],
      ['my drefyn password here', 'context'],
    ];
    for (const [password, rule] of families) {
      const result = await flow.setPassword(signedIn, { newPassword: password });
      expect(!result.ok && result.error.code, password).toBe('AUTH_PASSWORD_WEAK');
      expect(!result.ok && result.error.rules, password).toContain(rule);
    }
  });
});

describe('admitNewPassword', () => {
  const fields = { userId: 'usr_x' };

  it('runs the built in rules first and never asks the list about a weak password', async () => {
    const isBreached = listing('qwertyuiopasdfgh');
    const { logger } = recordingLogger();
    const result = await admitNewPassword(
      'qwertyuiopasdfgh',
      { email: 'person@example.com' },
      { check: { isBreached }, logger, fields },
    );
    expect(!result.ok && result.error.code).toBe('AUTH_PASSWORD_WEAK');
    expect(!result.ok && result.error.rules).toContain('keyboard_walk');
    expect(isBreached).not.toHaveBeenCalled();
  });

  it('then refuses a listed password and admits the rest', async () => {
    const check = { isBreached: listing(BREACHED) };
    const { logger } = recordingLogger();
    const refused = await admitNewPassword(BREACHED, {}, { check, logger, fields });
    expect(!refused.ok && refused.error.code).toBe('AUTH_PASSWORD_BREACHED');
    await expect(admitNewPassword(FRESH, {}, { check, logger, fields })).resolves.toEqual({
      ok: true,
    });
  });

  it('admits when the check has no answer, and counts it', async () => {
    const counted: AuthMetricName[] = [];
    const { logger, logs } = recordingLogger();
    const result = await admitNewPassword(
      BREACHED,
      {},
      {
        check: { isBreached: () => Promise.resolve(null) },
        logger,
        metrics: { increment: (name) => counted.push(name) },
        fields,
      },
    );
    expect(result).toEqual({ ok: true });
    expect(counted).toEqual(['auth.breach_check_unavailable']);
    expect(logs[0]?.fields).toEqual({ userId: 'usr_x', reason: 'no_answer' });
  });

  it('with no check, the rules alone decide', async () => {
    const { logger } = recordingLogger();
    await expect(admitNewPassword(BREACHED, {}, { logger, fields })).resolves.toEqual({ ok: true });
  });
});

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AuthError,
  breachedDigest,
  createPasswordSignIn,
  type AuthLogger,
  type AuthMetricName,
  type BreachedPasswordCheck,
  type SessionInfo,
} from '../src/index.ts';
import { on } from './email-fixtures.ts';
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

function infoLogger() {
  const logs: { level: string; event: string; fields: Readonly<Record<string, unknown>> }[] = [];
  const logger: AuthLogger = {
    warn(event, fields) {
      logs.push({ level: 'warn', event, fields });
    },
    info(event, fields) {
      logs.push({ level: 'info', event, fields });
    },
  };
  return { logger, logs };
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
    expect(result).toEqual({ ok: true, value: undefined });
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
      await expect(pending).resolves.toEqual({ ok: true, value: undefined });
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
  it('reads the file named by DREFYN_AUTH_BREACHED_PASSWORDS_FILE when no check is given', async () => {
    const path = join(dir, 'configured.bin');
    await writeFile(path, Buffer.concat([breachedDigest(BREACHED)]));
    const withFile = configWith({ DREFYN_AUTH_BREACHED_PASSWORDS_FILE: path });
    const t = passwordDeps({ known: true, phc: null });
    const flow = createPasswordSignIn(withFile, t.deps);
    const refused = await flow.setPassword(signedIn, { newPassword: BREACHED });
    expect(!refused.ok && refused.error.code).toBe('AUTH_PASSWORD_BREACHED');
    const accepted = await flow.setPassword(signedIn, { newPassword: FRESH });
    expect(accepted.ok).toBe(true);
  });

  it('a configured file that cannot be read accepts, logged and counted, and is tried again', async () => {
    const path = join(dir, 'arrives-later.bin');
    const withFile = configWith({ DREFYN_AUTH_BREACHED_PASSWORDS_FILE: path });
    const counted: AuthMetricName[] = [];
    const t = passwordDeps(
      { known: true, phc: null },
      { metrics: { increment: (name) => counted.push(name) } },
    );
    const flow = createPasswordSignIn(withFile, t.deps);
    const first = await flow.setPassword(signedIn, { newPassword: BREACHED });
    expect(first.ok).toBe(true);
    expect(counted).toEqual(['auth.breach_check_unavailable']);
    expect(t.logs.find((l) => l.event === 'auth.breach_check_unavailable')?.fields).toMatchObject({
      reason: 'error',
    });
    await writeFile(path, breachedDigest(BREACHED));
    const second = await flow.setPassword(signedIn, { newPassword: BREACHED });
    expect(!second.ok && second.error.code).toBe('AUTH_PASSWORD_BREACHED');
  });

  it('with no file, tells the operator once at start how to build one', () => {
    const { logger, logs } = infoLogger();
    const t = passwordDeps();
    createPasswordSignIn(config, { ...t.deps, logger });
    expect(config.passwords.breachedPasswordsFile).toBeNull();
    expect(logs.filter((l) => l.event === 'auth.breach_list_absent')).toEqual([
      {
        level: 'info',
        event: 'auth.breach_list_absent',
        fields: {
          guidance:
            'build a list with drefyn auth password-list build and set DREFYN_AUTH_BREACHED_PASSWORDS_FILE to its path',
        },
      },
    ]);
  });

  it('says nothing about a list when one is configured, given, or passwords are off', async () => {
    const path = join(dir, 'quiet.bin');
    await writeFile(path, breachedDigest(BREACHED));
    const cases = [
      { c: configWith({ DREFYN_AUTH_BREACHED_PASSWORDS_FILE: path }), extra: {} },
      { c: config, extra: { breachedPasswords: { isBreached: listing() } } },
      { c: configWith({ DREFYN_AUTH_PASSWORDS: 'off' }), extra: {} },
    ];
    for (const { c, extra } of cases) {
      const { logger, logs } = infoLogger();
      createPasswordSignIn(c, { ...passwordDeps().deps, ...extra, logger });
      expect(logs.filter((l) => l.event === 'auth.breach_list_absent')).toEqual([]);
    }
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

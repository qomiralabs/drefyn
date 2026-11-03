import type { AuthDatabase, Database } from '@drefyn/db';
import { describe, expect, it, vi } from 'vitest';
import {
  AuthError,
  createPasswordSignIn,
  decodeSecret,
  encodeSecret,
  type BotCheck,
  type SessionInfo,
} from '../src/index.ts';
import { smallHasher } from './password-fixtures.ts';
import {
  ADDRESS,
  IP,
  PASSWORD,
  PRE,
  PRE_COOKIE,
  USER,
  config,
  configWith,
  countingLimiter,
  csrfFor,
  passwordBrowser,
  passwordDeps,
  session,
} from './password-sign-in-fixtures.ts';
import { on } from './email-fixtures.ts';

const hasher = smallHasher();
const stored = await hasher.hash(PASSWORD);
const otherStored = await hasher.hash('a completely different one');
const CSRF = csrfFor(config);
const input = (extra: Partial<{ password: string; csrf: string; email: string }> = {}) => ({
  email: ADDRESS,
  password: PASSWORD,
  csrf: CSRF,
  ...extra,
});

describe('passwordForm', () => {
  it('keeps the pre cookie a browser holds and binds the field to it', () => {
    const t = passwordDeps();
    const flow = createPasswordSignIn(config, t.deps);
    const form = flow.passwordForm(passwordBrowser());
    expect(form.setCookies).toEqual([
      { name: config.cookies.pre, value: PRE_COOKIE, maxAgeSeconds: 15 * 60 },
    ]);
    expect(form.csrf).toBe(CSRF);
    expect(form.csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('sets a new pre cookie when there is none, and the field follows it', () => {
    const t = passwordDeps();
    const flow = createPasswordSignIn(config, {
      ...t.deps,
      random: (n) => new Uint8Array(n).fill(8),
    });
    const form = flow.passwordForm(passwordBrowser(config, null));
    const cookie = form.setCookies[0];
    expect(cookie?.name).toBe(config.cookies.pre);
    expect(decodeSecret(cookie?.value)?.equals(Buffer.alloc(32, 8))).toBe(true);
    expect(form.csrf).toBe(csrfFor(config, Buffer.alloc(32, 8)));
    expect(form.csrf).not.toBe(CSRF);
  });

  it('gives another field under another secret', () => {
    expect(csrfFor(configWith({}))).toBe(CSRF);
    const other = configWith({ DREFYN_AUTH_SECRET: Buffer.alloc(32, 1).toString('base64url') });
    expect(csrfFor(other)).not.toBe(CSRF);
  });
});

describe('the pre sign in binding', () => {
  it.each([
    ['no pre cookie', passwordBrowser(config, null), CSRF],
    ['a malformed pre cookie', passwordBrowser(config, 'nope'), CSRF],
    ['no field', passwordBrowser(), ''],
    ['a forged field', passwordBrowser(), 'A'.repeat(43)],
    ['a field from another browser', passwordBrowser(), csrfFor(config, Buffer.alloc(32, 9))],
    ['a field in the wrong alphabet', passwordBrowser(), `${CSRF.slice(0, 42)}=`],
  ])('refuses %s before anything is counted or read', async (_name, b, csrf) => {
    const t = passwordDeps({ known: true, phc: stored });
    const flow = createPasswordSignIn(config, t.deps);
    const result = await flow.signInWithPassword(b, input({ csrf }));
    expect(!result.ok && result.error.code).toBe('AUTH_ORIGIN_REFUSED');
    expect(t.reserve).not.toHaveBeenCalled();
    expect(t.scripted.events).toEqual([]);
    expect(t.spy.calls).toEqual([]);
    expect(t.sessions.startSession).not.toHaveBeenCalled();
  });

  it('accepts a field made with the previous secret during a rotation', async () => {
    const before = Buffer.alloc(32, 5).toString('base64url');
    const after = Buffer.alloc(32, 6).toString('base64url');
    const old = configWith({ DREFYN_AUTH_SECRET: before });
    const rotating = configWith({
      DREFYN_AUTH_SECRET: after,
      DREFYN_AUTH_SECRET_PREVIOUS: before,
    });
    const t = passwordDeps({ known: true, phc: stored });
    const flow = createPasswordSignIn(rotating, t.deps);
    const result = await flow.signInWithPassword(
      passwordBrowser(rotating),
      input({ csrf: csrfFor(old) }),
    );
    expect(result.ok).toBe(true);
  });
});

describe('signInWithPassword', () => {
  it('is refused whole while passwords are off', async () => {
    const off = configWith({ DREFYN_AUTH_PASSWORDS: 'off' });
    const t = passwordDeps({ known: true, phc: stored });
    const flow = createPasswordSignIn(off, t.deps);
    const result = await flow.signInWithPassword(
      passwordBrowser(off),
      input({ csrf: csrfFor(off) }),
    );
    expect(!result.ok && result.error.code).toBe('AUTH_PASSWORDS_DISABLED');
    expect(t.reserve).not.toHaveBeenCalled();
    expect(t.scripted.events).toEqual([]);
    expect(flow.passwordForm(passwordBrowser(off)).csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('signs in: counts first, reads in one short transaction, hashes outside it, then starts the session guarded by the hash it read', async () => {
    const t = passwordDeps({ known: true, phc: stored });
    const flow = createPasswordSignIn(config, t.deps);
    const result = await flow.signInWithPassword(passwordBrowser(), {
      ...input(),
      returnTo: '/acme/docs',
    });
    if (!result.ok) throw result.error;
    expect(t.reserve.mock.calls.map((c) => c[0])).toEqual(['password_fail', 'password_fail_ip']);
    // The read is one statement in one auth transaction, committed before the hash.
    const begins = t.scripted.events.filter((e) => e.kind === 'begin');
    expect(begins[0]).toEqual({ kind: 'begin', scope: 'auth' });
    const reads = t.scripted.statements().filter((s) => on(s, 'select', 'users'));
    expect(reads).toHaveLength(1);
    expect(reads[0]?.sql).toContain('"password_credentials"');
    expect(t.spy.calls).toEqual([{ kind: 'check', phc: stored, open: 0 }]);
    expect(t.sessions.startSession).toHaveBeenCalledTimes(1);
    expect(t.sessions.startSession.mock.calls[0]?.[1]).toEqual({
      userId: USER,
      method: 'password',
      credential: { phc: stored },
    });
    expect(result.value.returnTo).toBe('/acme/docs');
    expect(result.value.session.method).toBe('password');
  });

  it('records the known device the way email sign in does, and hands out its cookie', async () => {
    const t = passwordDeps({ known: true, phc: stored });
    const flow = createPasswordSignIn(config, {
      ...t.deps,
      random: (n) => new Uint8Array(n).fill(2),
    });
    const result = await flow.signInWithPassword(passwordBrowser(), input());
    if (!result.ok) throw result.error;
    const deviceWrite = t.scripted.statements().find((s) => on(s, 'insert', 'known_devices'));
    expect(deviceWrite?.parameters).toContain('Firefox on macOS');
    expect(result.value.setCookies.map((c) => c.name)).toEqual([
      config.cookies.session,
      config.cookies.device,
    ]);
    expect(result.value.setCookies[1]?.value).toBe(encodeSecret(Buffer.alloc(32, 2)));
    const userBegins = t.scripted.events.filter((e) => e.kind === 'begin' && e.scope === 'user');
    expect(userBegins).toEqual([{ kind: 'begin', scope: 'user', userId: USER }]);
  });

  it('a return path off the origin becomes /', async () => {
    const t = passwordDeps({ known: true, phc: stored });
    const flow = createPasswordSignIn(config, t.deps);
    const result = await flow.signInWithPassword(passwordBrowser(), {
      ...input(),
      returnTo: '//evil.example/x',
    });
    expect(result.ok && result.value.returnTo).toBe('/');
  });

  it('hands the new hash to the session step when the parameters moved', async () => {
    const bigger = smallHasher({ params: { memoryKib: 128, passes: 1, parallelism: 1 } });
    const t = passwordDeps({ known: true, phc: stored }, { hasher: bigger });
    const flow = createPasswordSignIn(config, t.deps);
    const result = await flow.signInWithPassword(passwordBrowser(), input());
    if (!result.ok) throw result.error;
    const credential = t.sessions.startSession.mock.calls[0]?.[1].credential as {
      phc: string;
      rehash?: string;
    };
    expect(credential.phc).toBe(stored);
    expect(credential.rehash).toMatch(/^\$argon2id\$v=19\$m=128,t=1,p=1\$/);
    await expect(bigger.verify(credential.rehash ?? '', PASSWORD)).resolves.toBe(true);
  });

  describe('one answer for every failure', () => {
    const cases = [
      ['an unknown address', { known: false }],
      ['a user with no password', { known: true, phc: null }],
      ['a wrong password', { known: true, phc: otherStored }],
    ] as const;

    it.each(cases)('%s gives AUTH_CREDENTIALS_INVALID after the same work', async (_n, user) => {
      const t = passwordDeps(user);
      const flow = createPasswordSignIn(config, t.deps);
      const result = await flow.signInWithPassword(passwordBrowser(), input());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('AUTH_CREDENTIALS_INVALID');
      expect(result.error.message).toBe(new AuthError('AUTH_CREDENTIALS_INVALID').message);
      expect(t.reserve).toHaveBeenCalledTimes(2);
      expect(t.scripted.statements()).toHaveLength(1);
      expect(t.spy.calls).toHaveLength(1);
      expect(t.spy.calls[0]?.kind).toBe('check');
      expect(t.sessions.startSession).not.toHaveBeenCalled();
    });

    it('every sign up mode answers the same, since a password never creates an account', async () => {
      const answers = new Set<string>();
      for (const mode of ['open', 'invite_only', 'closed']) {
        const c = configWith({ DREFYN_AUTH_SIGNUP: mode });
        for (const [, user] of cases) {
          const t = passwordDeps(user, { botCheck: { verify: () => Promise.resolve(true) } });
          const flow = createPasswordSignIn(c, t.deps);
          const result = await flow.signInWithPassword(
            passwordBrowser(c),
            input({ csrf: csrfFor(c) }),
          );
          if (result.ok) throw new Error('signed in');
          answers.add(
            JSON.stringify([
              result.error.code,
              result.error.message,
              t.scripted.statements().length,
            ]),
          );
        }
      }
      expect([...answers]).toEqual([
        JSON.stringify([
          'AUTH_CREDENTIALS_INVALID',
          'AUTH_CREDENTIALS_INVALID: address and password do not match',
          1,
        ]),
      ]);
    });

    it('an unreadable stored hash answers the same and is logged with the user id only', async () => {
      const t = passwordDeps({ known: true, phc: '$2b$12$notargon' });
      const flow = createPasswordSignIn(config, t.deps);
      const result = await flow.signInWithPassword(passwordBrowser(), input());
      expect(!result.ok && result.error.code).toBe('AUTH_CREDENTIALS_INVALID');
      const line = t.logs.find((l) => l.event === 'auth.password_hash_unreadable');
      expect(line?.fields).toEqual({ userId: expect.stringMatching(/^usr_/) as unknown });
    });
  });

  it('a rate limit refuses before anything is read or hashed', async () => {
    const t = passwordDeps({ known: true, phc: stored });
    const limiter = countingLimiter();
    const flow = createPasswordSignIn(config, { ...t.deps, limiter });
    const answers: string[] = [];
    for (let i = 0; i < 11; i += 1) {
      const result = await flow.signInWithPassword(
        passwordBrowser(),
        input({ password: 'wrong guess here' }),
      );
      answers.push(result.ok ? 'ok' : result.error.code);
    }
    expect(answers.slice(0, 10).every((a) => a === 'AUTH_CREDENTIALS_INVALID')).toBe(true);
    expect(answers[10]).toBe('AUTH_RATE_LIMITED');
    expect(t.spy.calls).toHaveLength(10);
    expect(t.scripted.statements()).toHaveLength(10);
  });

  it('200 parallel attempts against one address let at most the limit through to the hash', async () => {
    const t = passwordDeps({ known: true, phc: otherStored });
    const limiter = countingLimiter(configWith({ DREFYN_AUTH_RATE_PASSWORD_FAIL_IP: '1000/10m' }));
    const flow = createPasswordSignIn(config, { ...t.deps, limiter });
    const results = await Promise.all(
      Array.from({ length: 200 }, () => flow.signInWithPassword(passwordBrowser(), input())),
    );
    const codes = results.map((r) => (r.ok ? 'ok' : r.error.code));
    expect(codes.filter((c) => c === 'AUTH_CREDENTIALS_INVALID')).toHaveLength(10);
    expect(codes.filter((c) => c === 'AUTH_RATE_LIMITED')).toHaveLength(190);
    expect(t.spy.calls).toHaveLength(10);
  });

  it('unknown addresses are counted too', async () => {
    const t = passwordDeps({ known: false });
    const flow = createPasswordSignIn(config, t.deps);
    await flow.signInWithPassword(passwordBrowser(), input({ email: 'nobody@example.com' }));
    expect(t.reserve.mock.calls).toEqual([
      ['password_fail', ['nobody@example.com']],
      ['password_fail_ip', [`ip4:${IP}`]],
    ]);
  });

  it('an address that is not one, or an oversized password, is refused as input before counting', async () => {
    const t = passwordDeps();
    const flow = createPasswordSignIn(config, t.deps);
    const bad = await flow.signInWithPassword(
      passwordBrowser(),
      input({ email: 'not an address' }),
    );
    expect(!bad.ok && bad.error.code).toBe('AUTH_INPUT_INVALID');
    const huge = await flow.signInWithPassword(
      passwordBrowser(),
      input({ password: 'p'.repeat(4097) }),
    );
    expect(!huge.ok && huge.error.code).toBe('AUTH_INPUT_INVALID');
    expect(t.reserve).not.toHaveBeenCalled();
  });

  it('a database failure is AUTH_UNAVAILABLE', async () => {
    const t = passwordDeps();
    t.scripted.respondWith(() => {
      throw new Error('connection reset');
    });
    const flow = createPasswordSignIn(config, t.deps);
    const result = await flow.signInWithPassword(passwordBrowser(), input());
    expect(!result.ok && result.error.code).toBe('AUTH_UNAVAILABLE');
  });

  it('a full hash queue is AUTH_UNAVAILABLE, not a credentials answer', async () => {
    const t = passwordDeps({ known: true, phc: stored });
    const flow = createPasswordSignIn(config, {
      ...t.deps,
      hasher: {
        ...t.spy.hasher,
        check: () => Promise.reject(new AuthError('AUTH_UNAVAILABLE', { retryAfterSeconds: 1 })),
      },
    });
    const result = await flow.signInWithPassword(passwordBrowser(), input());
    expect(!result.ok && result.error).toMatchObject({
      code: 'AUTH_UNAVAILABLE',
      retryAfterSeconds: 1,
    });
  });

  describe('a reset or change between the read and the session (L-a)', () => {
    it('refuses when the stored hash changed to one the password does not match', async () => {
      const t = passwordDeps({ known: true, phc: stored }, {}, { known: true, phc: otherStored });
      t.sessions.startSession.mockRejectedValueOnce(new AuthError('AUTH_CREDENTIALS_INVALID'));
      const flow = createPasswordSignIn(config, t.deps);
      const result = await flow.signInWithPassword(passwordBrowser(), input());
      expect(!result.ok && result.error.code).toBe('AUTH_CREDENTIALS_INVALID');
      expect(t.sessions.startSession).toHaveBeenCalledTimes(1);
      // Read again and checked against what is stored now, once.
      expect(t.scripted.statements().filter((s) => on(s, 'select', 'users'))).toHaveLength(2);
      expect(t.spy.calls.map((c) => c.phc)).toEqual([stored, otherStored]);
      expect(t.reserve).toHaveBeenCalledTimes(2);
    });

    it('refuses when the password was removed in between', async () => {
      const t = passwordDeps({ known: true, phc: stored }, {}, { known: true, phc: null });
      t.sessions.startSession.mockRejectedValueOnce(new AuthError('AUTH_CREDENTIALS_INVALID'));
      const flow = createPasswordSignIn(config, t.deps);
      const result = await flow.signInWithPassword(passwordBrowser(), input());
      expect(!result.ok && result.error.code).toBe('AUTH_CREDENTIALS_INVALID');
      expect(t.sessions.startSession).toHaveBeenCalledTimes(1);
    });

    it('signs in when a parallel sign in only rehashed the same password', async () => {
      const rehashed = await smallHasher().hash(PASSWORD);
      const t = passwordDeps({ known: true, phc: stored }, {}, { known: true, phc: rehashed });
      t.sessions.startSession.mockRejectedValueOnce(new AuthError('AUTH_CREDENTIALS_INVALID'));
      const flow = createPasswordSignIn(config, t.deps);
      const result = await flow.signInWithPassword(passwordBrowser(), input());
      expect(result.ok).toBe(true);
      expect(t.sessions.startSession.mock.calls.map((c) => c[1].credential?.phc)).toEqual([
        stored,
        rehashed,
      ]);
    });

    it('gives up after one retry', async () => {
      const t = passwordDeps({ known: true, phc: stored });
      t.sessions.startSession.mockRejectedValue(new AuthError('AUTH_CREDENTIALS_INVALID'));
      const flow = createPasswordSignIn(config, t.deps);
      const result = await flow.signInWithPassword(passwordBrowser(), input());
      expect(!result.ok && result.error.code).toBe('AUTH_CREDENTIALS_INVALID');
      expect(t.sessions.startSession).toHaveBeenCalledTimes(2);
    });
  });
});

describe('the BotCheck seam', () => {
  it('with no bot check, nothing is asked and the flow is unchanged', async () => {
    const plain = passwordDeps({ known: true, phc: stored });
    const result = await createPasswordSignIn(config, plain.deps).signInWithPassword(
      passwordBrowser(),
      input(),
    );
    expect(result.ok).toBe(true);
    const checked = passwordDeps({ known: true, phc: stored });
    const verify = vi.fn<BotCheck['verify']>(() => Promise.resolve(true));
    await createPasswordSignIn(config, {
      ...checked.deps,
      botCheck: { verify },
    }).signInWithPassword(passwordBrowser(), { ...input(), botToken: 'token' });
    expect(verify).toHaveBeenCalledWith('token', IP, 'password_sign_in');
    expect(plain.scripted.statements().map((s) => s.sql)).toEqual(
      checked.scripted.statements().map((s) => s.sql),
    );
  });

  it.each([
    ['refuses', () => Promise.resolve(false)],
    ['is down', () => Promise.reject(new Error('provider timeout'))],
  ])('when the bot check %s, the attempt fails closed before the hash', async (_n, answer) => {
    const t = passwordDeps({ known: true, phc: stored });
    const flow = createPasswordSignIn(config, { ...t.deps, botCheck: { verify: answer } });
    const result = await flow.signInWithPassword(passwordBrowser(), input());
    expect(!result.ok && result.error.code).toBe('AUTH_BOT_CHECK_REQUIRED');
    expect(t.spy.calls).toEqual([]);
    expect(t.scripted.statements()).toEqual([]);
    expect(t.reserve).toHaveBeenCalledTimes(2);
  });

  it('open sign up with no bot check logs one warning when built, and none otherwise', () => {
    const open = configWith({ DREFYN_AUTH_SIGNUP: 'open' });
    const warned = passwordDeps();
    createPasswordSignIn(open, warned.deps);
    expect(warned.logs).toEqual([{ event: 'auth.signup_open_without_bot_check', fields: {} }]);
    const checked = passwordDeps();
    createPasswordSignIn(open, {
      ...checked.deps,
      botCheck: { verify: () => Promise.resolve(true) },
    });
    expect(checked.logs).toEqual([]);
    const invite = passwordDeps();
    createPasswordSignIn(config, invite.deps);
    expect(invite.logs).toEqual([]);
  });
});

describe('setPassword', () => {
  const signedIn: SessionInfo = session;

  it('sets a first password after a recent sign in, hashing outside any transaction', async () => {
    const t = passwordDeps({ known: true, phc: null });
    const flow = createPasswordSignIn(config, t.deps);
    const result = await flow.setPassword(signedIn, { newPassword: 'a brand new sentence' });
    expect(result).toEqual({ ok: true, value: undefined });
    expect(t.sessions.requireRecentAuth).toHaveBeenCalledWith(signedIn);
    expect(t.spy.calls).toEqual([{ kind: 'hash', phc: null, open: 0 }]);
    const insert = t.scripted.statements().find((s) => on(s, 'insert', 'password_credentials'));
    expect(insert?.sql).toMatch(/on conflict/i);
    const phc = insert?.parameters.find((p) => typeof p === 'string' && p.startsWith('$argon2id$'));
    await expect(smallHasher().verify(String(phc), 'a brand new sentence')).resolves.toBe(true);
    expect(t.scripted.events.filter((e) => e.kind === 'begin')).toEqual([
      { kind: 'begin', scope: 'user', userId: USER },
      { kind: 'begin', scope: 'user', userId: USER },
    ]);
    expect(t.logs.find((l) => l.event === 'auth.password_set')?.fields).toEqual({
      userId: expect.stringMatching(/^usr_/) as unknown,
    });
  });

  it('names the rules a weak password breaks and hashes nothing', async () => {
    const t = passwordDeps();
    const flow = createPasswordSignIn(config, t.deps);
    const result = await flow.setPassword(signedIn, { newPassword: 'person drefyn' });
    expect(!result.ok && result.error).toMatchObject({
      code: 'AUTH_PASSWORD_WEAK',
      rules: ['too_short', 'context'],
    });
    expect(t.spy.calls).toEqual([]);
    expect(t.scripted.events).toEqual([]);
  });

  it('needs a recent sign in', async () => {
    const t = passwordDeps();
    t.sessions.requireRecentAuth.mockResolvedValueOnce({
      ok: false,
      error: new AuthError('AUTH_RECENT_AUTH_REQUIRED'),
    } as never);
    const flow = createPasswordSignIn(config, t.deps);
    const result = await flow.setPassword(signedIn, { newPassword: 'a brand new sentence' });
    expect(!result.ok && result.error.code).toBe('AUTH_RECENT_AUTH_REQUIRED');
    expect(t.spy.calls).toEqual([]);
  });

  it('never replaces a password that is already set', async () => {
    const t = passwordDeps({ known: true, phc: stored });
    const flow = createPasswordSignIn(config, t.deps);
    const result = await flow.setPassword(signedIn, { newPassword: 'a brand new sentence' });
    expect(!result.ok && result.error.code).toBe('AUTH_FORBIDDEN');
    expect(t.spy.calls).toEqual([]);
    expect(t.scripted.writes()).toEqual([]);
  });

  it('loses cleanly to a password set in another tab during the hash', async () => {
    const t = passwordDeps({ known: true, phc: null });
    const flow = createPasswordSignIn(config, t.deps);
    // Nothing stored at the check, and the insert then finds a row and writes nothing.
    t.scripted.respondWith(() => []);
    const result = await flow.setPassword(signedIn, { newPassword: 'a brand new sentence' });
    expect(!result.ok && result.error.code).toBe('AUTH_FORBIDDEN');
  });

  it('is refused while passwords are off, and oversized input is refused as input', async () => {
    const off = configWith({ DREFYN_AUTH_PASSWORDS: 'off' });
    const t = passwordDeps();
    const disabled = await createPasswordSignIn(off, t.deps).setPassword(signedIn, {
      newPassword: 'a brand new sentence',
    });
    expect(!disabled.ok && disabled.error.code).toBe('AUTH_PASSWORDS_DISABLED');
    const huge = await createPasswordSignIn(config, t.deps).setPassword(signedIn, {
      newPassword: 'p'.repeat(5000),
    });
    expect(!huge.ok && huge.error.code).toBe('AUTH_INPUT_INVALID');
    expect(t.scripted.events).toEqual([]);
  });

  it('a database failure is AUTH_UNAVAILABLE', async () => {
    const t = passwordDeps();
    t.scripted.respondWith(() => {
      throw new Error('gone');
    });
    const result = await createPasswordSignIn(config, t.deps).setPassword(signedIn, {
      newPassword: 'a brand new sentence',
    });
    expect(!result.ok && result.error.code).toBe('AUTH_UNAVAILABLE');
  });
});

it('the binding check costs nothing a browser can time per address', () => {
  // The field depends only on the pre cookie, never on the address typed.
  const t = passwordDeps();
  const flow = createPasswordSignIn(config, t.deps);
  const a = flow.passwordForm(passwordBrowser());
  const b = flow.passwordForm({ ...passwordBrowser(), ip: '198.51.100.1' });
  expect(a.csrf).toBe(b.csrf);
  expect(PRE).toHaveLength(32);
});

describe('construction and failure paths', () => {
  it('builds its own store, limiter, sessions and hasher from the two databases', () => {
    const logger = { warn: () => undefined };
    const flow = createPasswordSignIn(config, {
      db: {} as Database,
      authDb: {} as AuthDatabase,
      logger,
    });
    const form = flow.passwordForm(passwordBrowser(config, null));
    expect(form.setCookies[0]?.name).toBe(config.cookies.pre);
  });

  it('refuses to build without databases or the parts they would give', () => {
    expect(() => createPasswordSignIn(config, { logger: { warn: () => undefined } })).toThrow(
      TypeError,
    );
  });

  it('a session step failure other than a changed hash is passed on', async () => {
    const t = passwordDeps({ known: true, phc: stored });
    t.sessions.startSession.mockRejectedValueOnce(new AuthError('AUTH_UNAVAILABLE'));
    const result = await createPasswordSignIn(config, t.deps).signInWithPassword(
      passwordBrowser(),
      input(),
    );
    expect(!result.ok && result.error.code).toBe('AUTH_UNAVAILABLE');
    expect(t.sessions.startSession).toHaveBeenCalledTimes(1);
  });

  it('a bot check that never answers fails closed after its timeout', async () => {
    vi.useFakeTimers();
    try {
      const t = passwordDeps({ known: true, phc: stored });
      const flow = createPasswordSignIn(config, {
        ...t.deps,
        botCheck: { verify: () => new Promise<boolean>(() => undefined) },
      });
      const pending = flow.signInWithPassword(passwordBrowser(), input());
      await vi.advanceTimersByTimeAsync(3_000);
      const result = await pending;
      expect(!result.ok && result.error.code).toBe('AUTH_BOT_CHECK_REQUIRED');
      expect(t.spy.calls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

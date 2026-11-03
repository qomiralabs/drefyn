import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  SESSIONS_PAGE_PLACEHOLDER_PATH,
  createEmailSignIn,
  createPasswordSignIn,
  encodeSecret,
  newDeviceNotice,
  recordDevice,
  userAgentFamily,
} from '../src/index.ts';
import { createTestAuthMailer } from '../src/testing.ts';
import { scriptedStore, type Responder } from './scripted-store.ts';
import {
  ADDRESS,
  CHALLENGE,
  USER,
  browser,
  challengeRow,
  config,
  fakeLimiter,
  fakeSessions,
  on,
  recordingLogger,
} from './email-fixtures.ts';
import { csrfFor, fakePasswordSessions, passwordBrowser } from './password-sign-in-fixtures.ts';
import { smallHasher } from './password-fixtures.ts';
import { runs } from './support.ts';

const SEEN_AT = new Date('2026-11-03T08:00:00.000Z');
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';

// The upsert answers whether the device counts as new, the way the database decides it.
const deviceResponder =
  (fresh: boolean, rest: Responder = () => []): Responder =>
  (s) =>
    on(s, 'insert', 'known_devices') ? [{ fresh, at: SEEN_AT }] : rest(s);

describe('recordDevice and the new device decision', () => {
  it('reports a new device with its family and database time', async () => {
    const scripted = scriptedStore(deviceResponder(true));
    const { logger } = recordingLogger();
    const recorded = await recordDevice(
      config,
      { store: scripted.store, logger },
      { ...browser(), userAgent: FIREFOX },
      USER,
    );
    expect(recorded.newDevice).toEqual({ device: 'Firefox on Linux', at: SEEN_AT });
    expect(recorded.setCookies.map((c) => c.name)).toEqual([config.cookies.device]);
    const insert = scripted.writes().find((s) => on(s, 'insert', 'known_devices'));
    // The decision is the row as it was before this write: absent or unseen for 90 days.
    expect(insert?.sql).toMatch(/old\.last_seen_at/);
    expect(insert?.sql).toMatch(/90 days/);
  });

  it('reports nothing for a device seen recently', async () => {
    const scripted = scriptedStore(deviceResponder(false));
    const b = browser();
    const cookies = new Map(b.cookies);
    cookies.set(config.cookies.device, encodeSecret(Buffer.alloc(32, 3)));
    const recorded = await recordDevice(
      config,
      { store: scripted.store, logger: recordingLogger().logger },
      { ...b, cookies },
      USER,
    );
    expect(recorded).toEqual({ setCookies: [], newDevice: null });
  });

  it('reports nothing when the write fails', async () => {
    const scripted = scriptedStore(() => {
      throw new Error('down');
    });
    const recorded = await recordDevice(
      config,
      { store: scripted.store, logger: recordingLogger().logger },
      browser(),
      USER,
    );
    expect(recorded).toEqual({ setCookies: [], newDevice: null });
  });
});

describe('newDeviceNotice', () => {
  it('names the method, time and device, and links to the sessions page', async () => {
    const mail = createTestAuthMailer();
    const { logger } = recordingLogger();
    const send = newDeviceNotice(config, mail.mailer, logger, {
      to: ADDRESS,
      userId: USER,
      method: 'password',
      seen: { device: 'Safari on iOS', at: SEEN_AT },
    });
    await send();
    expect(mail.notices).toEqual([
      {
        to: ADDRESS,
        notice: {
          kind: 'new_device_sign_in',
          method: 'password',
          device: 'Safari on iOS',
          at: SEEN_AT,
          sessionsLink: new URL(SESSIONS_PAGE_PLACEHOLDER_PATH, config.appOrigin),
        },
      },
    ]);
  });

  it('logs a failed or missing mailer with the user id only, and never throws', async () => {
    const mail = createTestAuthMailer();
    mail.failNext();
    const { logger, logs } = recordingLogger();
    const input = {
      to: ADDRESS,
      userId: USER,
      method: 'email' as const,
      seen: { device: 'Other', at: SEEN_AT },
    };
    await newDeviceNotice(config, mail.mailer, logger, input)();
    await newDeviceNotice(config, {}, logger, input)();
    expect(logs.map((l) => l.event)).toEqual([
      'auth.device_notice_failed',
      'auth.device_notice_failed',
    ]);
    expect(JSON.stringify(logs)).not.toContain(ADDRESS);
  });
});

describe('sign in flows send the new device notice', () => {
  const codeHmac = (code: string) => config.keys.mac('code', [CHALLENGE, 'sign_in', code]);

  function emailFlow(fresh: boolean, userId: string | null = USER) {
    const challenge = challengeRow({ codeHmac: codeHmac('48312097'), userId });
    const scripted = scriptedStore(
      deviceResponder(fresh, (s) => {
        if (on(s, 'select', 'users')) return [{ id: USER }];
        if (on(s, 'insert', 'users')) return [{ id: USER }];
        if (on(s, 'select', 'email_challenges') || on(s, 'update', 'email_challenges')) {
          return [{ ...challenge, consumed: false }];
        }
        return [];
      }),
    );
    const mail = createTestAuthMailer();
    const signIn = createEmailSignIn(
      { ...config, signUp: 'open' },
      {
        store: scripted.store,
        logger: recordingLogger().logger,
        mailer: mail.mailer,
        sessions: fakeSessions(),
        limiter: fakeLimiter(),
      },
    );
    return { signIn, mail };
  }

  it('an email code sign in from a new device mails one notice after the response', async () => {
    const { signIn, mail } = emailFlow(true);
    const result = await signIn.verifyEmailCode(browser(), { code: '48312097' });
    if (!result.ok) throw result.error;
    expect(mail.notices).toEqual([]);
    await result.value.send?.();
    expect(
      mail.notices.map((n) => [n.notice.kind, 'method' in n.notice && n.notice.method]),
    ).toEqual([['new_device_sign_in', 'email']]);
  });

  it('a known device sends none', async () => {
    const { signIn, mail } = emailFlow(false);
    const result = await signIn.verifyEmailCode(browser(), { code: '48312097' });
    if (!result.ok) throw result.error;
    await result.value.send?.();
    expect(mail.notices).toEqual([]);
  });

  it('the sign in that creates the account sends none', async () => {
    const scripted = scriptedStore(
      deviceResponder(true, (s) => {
        if (on(s, 'select', 'users')) return [];
        if (on(s, 'insert', 'users')) return [{ id: USER }];
        if (on(s, 'select', 'email_challenges') || on(s, 'update', 'email_challenges')) {
          return [
            { ...challengeRow({ codeHmac: codeHmac('48312097'), userId: null }), consumed: false },
          ];
        }
        return [];
      }),
    );
    const mail = createTestAuthMailer();
    const signIn = createEmailSignIn(
      { ...config, signUp: 'open' },
      {
        store: scripted.store,
        logger: recordingLogger().logger,
        mailer: mail.mailer,
        sessions: fakeSessions(),
        limiter: fakeLimiter(),
      },
    );
    const result = await signIn.verifyEmailCode(browser(), { code: '48312097' });
    if (!result.ok) throw result.error;
    await result.value.send?.();
    expect(mail.notices).toEqual([]);
  });

  it('a password sign in from a new device mails a notice naming the password method', async () => {
    const hasher = smallHasher();
    const phc = await hasher.hash('a long and quiet sentence');
    const scripted = scriptedStore(
      deviceResponder(true, (s) => (on(s, 'select', 'users') ? [{ id: USER, phc }] : [])),
    );
    const mail = createTestAuthMailer();
    const flow = createPasswordSignIn(config, {
      store: scripted.store,
      logger: recordingLogger().logger,
      limiter: fakeLimiter(),
      sessions: fakePasswordSessions(),
      hasher,
      mailer: mail.mailer,
    });
    const result = await flow.signInWithPassword(passwordBrowser(), {
      email: ADDRESS,
      password: 'a long and quiet sentence',
      csrf: csrfFor(config),
    });
    if (!result.ok) throw result.error;
    await result.value.send?.();
    expect(mail.notices.map((n) => n.notice.kind)).toEqual(['new_device_sign_in']);
  });
});

describe('device family', () => {
  const templates: readonly ((major: number, minor: number) => string)[] = [
    (a, b) => `Mozilla/5.0 (X11; Linux x86_64; rv:${a}.${b}) Gecko/20100101 Firefox/${a}.${b}`,
    (a, b) =>
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${a}.${b}.0.0 Safari/537.36`,
    (a, b) =>
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 15_${b}) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${a}.${b} Safari/605.1.15`,
    (a, b) =>
      `Mozilla/5.0 (iPhone; CPU iPhone OS ${a}_${b} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${a}.${b} Mobile/15E148 Safari/604.1`,
    (a, b) =>
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${a}.0.0.0 Safari/537.36 Edg/${a}.${b}.0`,
  ];

  it('is the same across version changes of one browser', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...templates),
        fc.integer({ min: 1, max: 999 }),
        fc.integer({ min: 0, max: 99 }),
        fc.integer({ min: 1, max: 999 }),
        fc.integer({ min: 0, max: 99 }),
        (template, a, b, c, d) => {
          expect(userAgentFamily(template(a, b))).toBe(userAgentFamily(template(c, d)));
        },
      ),
      runs,
    );
  });
});

import * as crypto from 'node:crypto';
import type * as Crypto from 'node:crypto';
import type { AuthDatabase, Database } from '@drefyn/db';
import { idOf } from '@drefyn/tenancy';
import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  createInvitations,
  formatInvitationToken,
  SIGN_IN_CODE_PURPOSES,
  createCodeIssuer,
  createEmailSignIn,
  formatChallengeId,
  parseAuthConfig,
  parseSignInCodePurpose,
  parseVerifyFragment,
  sha256,
} from '../src/index.ts';
import { createTestAuthMailer } from '../src/testing.ts';
import {
  ADDRESS,
  CHALLENGE,
  PRE,
  USER,
  browser,
  challengeRow,
  config,
  emailResponder,
  on,
  unitDeps,
} from './email-fixtures.ts';
import { validEnv } from './support.ts';

// Real implementations underneath; the spies only watch, except where a test pins a value.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof Crypto>();
  return {
    ...actual,
    randomInt: vi.fn(actual.randomInt),
    timingSafeEqual: vi.fn(actual.timingSafeEqual),
  };
});

const randomInt = crypto.randomInt as unknown as Mock<(min: number, max: number) => number>;
const timingSafeEqual = crypto.timingSafeEqual as unknown as Mock<
  (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => boolean
>;

const codeHmac = (challengeId: string, code: string, purpose = 'sign_in') =>
  config.keys.mac('code', [challengeId, purpose, code]);

async function started(known = true) {
  const t = unitDeps(emailResponder({ known }));
  const flow = createEmailSignIn(config, t.deps);
  const result = await flow.startEmailSignIn(browser(), { email: ADDRESS });
  if (!result.ok) throw result.error;
  await result.value.send();
  return { ...t, result: result.value };
}

describe('code generation', () => {
  it('draws 8 digits from crypto.randomInt and keeps leading zeros', async () => {
    randomInt.mockReturnValueOnce(42);
    const { mail } = await started();
    expect(randomInt).toHaveBeenCalledWith(0, 100_000_000);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]?.code).toBe('00000042');
  });

  it('puts the challenge and code in the link fragment only', async () => {
    const { mail } = await started();
    const sent = mail.sent[0];
    expect(sent?.link.origin).toBe(config.appOrigin);
    expect(sent?.link.pathname).toBe('/sign-in/verify');
    expect(sent?.link.search).toBe('');
    const fragment = parseVerifyFragment(sent?.link.hash.slice(1));
    expect(fragment?.code).toBe(sent?.code);
  });
});

describe('HMAC input', () => {
  it('stores HMAC(subkey_code, challenge id, purpose, code) and never the code', async () => {
    const { mail, scripted } = await started();
    const sent = mail.sent[0];
    const fragment = parseVerifyFragment(sent?.link.hash.slice(1));
    if (sent === undefined || fragment === null) throw new Error('no mail');
    const insert = scripted.writes().find((s) => on(s, 'insert', 'email_challenges'));
    const params = insert?.parameters ?? [];
    const expected = codeHmac(fragment.challengeId, sent.code);
    expect(params.some((p) => Buffer.isBuffer(p) && p.equals(expected))).toBe(true);
    expect(params).toContain(fragment.challengeId);
    expect(params).toContain('sign_in');
    expect(JSON.stringify(params)).not.toContain(sent.code);
  });

  it('binds the row to sha256 of the pre sign in cookie', async () => {
    const { scripted } = await started();
    const insert = scripted.writes().find((s) => on(s, 'insert', 'email_challenges'));
    const binding = sha256(PRE);
    expect(insert?.parameters.some((p) => Buffer.isBuffer(p) && p.equals(binding))).toBe(true);
  });
});

describe('the compare', () => {
  async function verify(code: string, stored: string) {
    const t = unitDeps(
      emailResponder({ challenge: challengeRow({ codeHmac: codeHmac(CHALLENGE, stored) }) }),
    );
    const flow = createEmailSignIn(config, t.deps);
    timingSafeEqual.mockClear();
    const result = await flow.verifyEmailCode(browser(), {
      challenge: formatChallengeId(CHALLENGE),
      code,
    });
    return { result, t };
  }

  it('runs timingSafeEqual on the two 32 byte HMACs for a right code', async () => {
    const { result } = await verify('48312097', '48312097');
    expect(result.ok).toBe(true);
    const expected = codeHmac(CHALLENGE, '48312097');
    const onHmacs = timingSafeEqual.mock.calls.filter(
      ([a, b]) =>
        Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(expected) &&
        Buffer.from(b.buffer, b.byteOffset, b.byteLength).equals(expected),
    );
    expect(onHmacs.length).toBeGreaterThanOrEqual(1);
  });

  it('runs timingSafeEqual for a wrong code too, and refuses it', async () => {
    const { result } = await verify('11111111', '48312097');
    expect(!result.ok && result.error.code).toBe('AUTH_CODE_INVALID');
    const stored = codeHmac(CHALLENGE, '48312097');
    const onStored = timingSafeEqual.mock.calls.filter(
      ([a, b]) =>
        a.byteLength === 32 &&
        b.byteLength === 32 &&
        Buffer.from(b.buffer, b.byteOffset, b.byteLength).equals(stored),
    );
    expect(onStored.length).toBeGreaterThanOrEqual(1);
  });

  it('drops typed spaces, tabs and no break spaces, and nothing else', async () => {
    for (const typed of ['4831 2097', '4831\t2097', '4831\u00a02097', ' 48312097 ']) {
      const { result } = await verify(typed, '48312097');
      expect(result.ok).toBe(true);
    }
    for (const typed of ['4831-2097', '4831\n2097', '4831.2097', '483120970']) {
      const { result } = await verify(typed, '48312097');
      expect(!result.ok && result.error.code).toBe('AUTH_CODE_INVALID');
    }
  });

  it('creates the session only after the code proved, with method email', async () => {
    const { result, t } = await verify('48312097', '48312097');
    expect(result.ok).toBe(true);
    expect(t.sessions.startSession).toHaveBeenCalledTimes(1);
    expect(t.sessions.startSession.mock.calls[0]).toMatchObject([
      expect.anything(),
      { method: 'email' },
    ]);
    const wrong = await verify('11111111', '48312097');
    expect(wrong.t.sessions.startSession).not.toHaveBeenCalled();
  });
});

describe('mailer purposes', () => {
  const issuerWith = () => {
    const t = unitDeps(emailResponder());
    const issuer = createCodeIssuer(config, {
      store: t.deps.store,
      logger: t.deps.logger,
      mailer: t.mail.mailer,
    });
    return { issuer, mail: t.mail };
  };

  it('knows exactly the five mail purposes and refuses cli_link', () => {
    expect([...SIGN_IN_CODE_PURPOSES].sort()).toEqual(
      ['email_change', 'link_identity', 'password_reset', 'sign_in', 'step_up'].sort(),
    );
    for (const purpose of SIGN_IN_CODE_PURPOSES)
      expect(parseSignInCodePurpose(purpose)).toBe(purpose);
    expect(parseSignInCodePurpose('cli_link')).toBeNull();
    expect(parseSignInCodePurpose('SIGN_IN')).toBeNull();
    expect(parseSignInCodePurpose(undefined)).toBeNull();
  });

  it.each(['sign_in', 'step_up', 'password_reset', 'email_change'] as const)(
    'calls the mailer with purpose %s and no linking',
    async (purpose) => {
      const { issuer, mail } = issuerWith();
      const issued = await issuer.issue(browser(), {
        purpose,
        email: ADDRESS,
        userId: purpose === 'sign_in' ? null : USER,
      });
      if (!issued.ok) throw issued.error;
      await issued.value.send();
      expect(mail.sent).toHaveLength(1);
      expect(mail.sent[0]).toMatchObject({ to: ADDRESS, purpose });
      expect(mail.sent[0]?.linking).toBeUndefined();
    },
  );

  it('calls the mailer for link_identity with the provider and account', async () => {
    const { issuer, mail } = issuerWith();
    const issued = await issuer.issue(browser(), {
      purpose: 'link_identity',
      email: ADDRESS,
      userId: USER,
      linking: { provider: 'github', account: 'octocat', subject: '583231' },
    });
    if (!issued.ok) throw issued.error;
    await issued.value.send();
    expect(mail.sent[0]).toMatchObject({
      purpose: 'link_identity',
      linking: { provider: 'github', account: 'octocat' },
    });
  });

  it('refuses linking details on any other purpose, and link_identity without them', async () => {
    const { issuer, mail } = issuerWith();
    const stray = await issuer.issue(browser(), {
      purpose: 'sign_in',
      email: ADDRESS,
      userId: null,
      linking: { provider: 'google', account: 'a@example.com', subject: '1' },
    });
    expect(!stray.ok && stray.error.code).toBe('AUTH_INPUT_INVALID');
    const bare = await issuer.issue(browser(), {
      purpose: 'link_identity',
      email: ADDRESS,
      userId: USER,
    });
    expect(!bare.ok && bare.error.code).toBe('AUTH_INPUT_INVALID');
    expect(mail.sent).toHaveLength(0);
  });

  it('refuses a purpose outside the five before any statement', async () => {
    const t = unitDeps(emailResponder());
    const issuer = createCodeIssuer(config, {
      store: t.deps.store,
      logger: t.deps.logger,
      mailer: t.mail.mailer,
    });
    const result = await issuer.issue(browser(), {
      purpose: 'cli_link' as 'sign_in',
      email: ADDRESS,
      userId: null,
    });
    expect(!result.ok && result.error.code).toBe('AUTH_INPUT_INVALID');
    expect(t.scripted.statements()).toHaveLength(0);
  });
});

describe('the test mailer', () => {
  it('records each call and can be told to fail or to wait', async () => {
    const mail = createTestAuthMailer({ delayMs: 20 });
    const link = new URL('https://app.drefyn.test/sign-in/verify#x');
    const before = performance.now();
    await mail.mailer.sendSignInCode(ADDRESS, '12345678', link, 'sign_in');
    expect(performance.now() - before).toBeGreaterThanOrEqual(15);
    mail.failNext();
    await expect(
      mail.mailer.sendSignInCode(ADDRESS, '12345678', link, 'sign_in'),
    ).rejects.toThrow();
    expect(mail.sent).toHaveLength(1);
  });
});

describe('start', () => {
  it('sends the mail only when send runs, so the response never waits on SMTP', async () => {
    const t = unitDeps(emailResponder());
    const flow = createEmailSignIn(config, t.deps);
    const result = await flow.startEmailSignIn(browser(), { email: ADDRESS });
    expect(result.ok).toBe(true);
    expect(t.mail.sent).toHaveLength(0);
    if (result.ok) await result.value.send();
    expect(t.mail.sent).toHaveLength(1);
  });

  it('send never throws when the mailer fails', async () => {
    const t = unitDeps(emailResponder());
    t.mail.failNext();
    const flow = createEmailSignIn(config, t.deps);
    const result = await flow.startEmailSignIn(browser(), { email: ADDRESS });
    if (!result.ok) throw result.error;
    await expect(result.value.send()).resolves.toBeUndefined();
  });

  it('sets a pre sign in cookie for 15 minutes when the browser has none', async () => {
    const t = unitDeps(emailResponder());
    const flow = createEmailSignIn(config, t.deps);
    const result = await flow.startEmailSignIn(browser(null), { email: ADDRESS });
    if (!result.ok) throw result.error;
    const pre = result.value.setCookies.find((c) => c.name === config.cookies.pre);
    expect(pre?.maxAgeSeconds).toBe(900);
    expect(pre?.value).toMatch(/^[0-9a-hjkmnp-tv-z]{52}$/);
  });

  it('keeps a valid pre sign in cookie the browser already holds', async () => {
    const t = unitDeps(emailResponder());
    const flow = createEmailSignIn(config, t.deps);
    const result = await flow.startEmailSignIn(browser(), { email: ADDRESS });
    if (!result.ok) throw result.error;
    const pre = result.value.setCookies.find((c) => c.name === config.cookies.pre);
    expect(pre?.value).toBe(browser().cookies.get(config.cookies.pre));
  });

  it('refuses an address the address rule refuses, before any statement', async () => {
    const t = unitDeps(emailResponder());
    const flow = createEmailSignIn(config, t.deps);
    const result = await flow.startEmailSignIn(browser(), { email: 'a"b"@example.com' });
    expect(!result.ok && result.error.code).toBe('AUTH_INPUT_INVALID');
    expect(t.scripted.statements()).toHaveLength(0);
  });

  it('reserves the send limits before it writes the challenge', async () => {
    const t = unitDeps(emailResponder());
    const flow = createEmailSignIn(config, t.deps);
    await flow.startEmailSignIn(browser(), { email: ADDRESS });
    const buckets = (t.limiter.reserve as Mock).mock.calls.map(([bucket]) => bucket as string);
    expect(buckets).toEqual(
      expect.arrayContaining(['email_send', 'email_send_ip', 'email_send_address_ceiling']),
    );
  });
});

// A tripwire on the work start does: the same reservations, transactions, statements and
// invitation checks for every address in every mode, with or without a held invitation, so
// neither a count nor a time can tell a known address from an unknown one.
describe('start does the same work for every address', () => {
  const modes = ['open', 'closed', 'invite_only'] as const;
  const held = formatInvitationToken({
    organizationId: idOf('org', '01890a5d-ac96-774b-bcce-b302099a8070'),
    invitationId: idOf('inv', '01890a5d-ac96-774b-bcce-b302099a8072'),
    secret: Buffer.alloc(32, 5),
  });

  async function workFor(mode: (typeof modes)[number], known: boolean, cookie: string | null) {
    const cfg = parseAuthConfig({ ...validEnv(), DREFYN_AUTH_SIGNUP: mode });
    const t = unitDeps(emailResponder({ known }));
    const real = createInvitations(cfg, {
      db: {} as Database,
      authDb: {} as AuthDatabase,
      logger: { warn: () => undefined },
      mailer: {
        sendInvitation: () => Promise.resolve(),
        sendSecurityNotice: () => Promise.resolve(),
      },
      store: t.scripted.store,
    });
    const allowsSignUp = vi.fn((token: string | null, email: string) =>
      real.allowsSignUp(token, email),
    );
    const flow = createEmailSignIn(cfg, { ...t.deps, invitations: { allowsSignUp } });
    const b = browser();
    const cookies = new Map(b.cookies);
    if (cookie !== null) cookies.set(cfg.cookies.invite, cookie);
    const result = await flow.startEmailSignIn({ ...b, cookies }, { email: ADDRESS });
    expect(result.ok).toBe(true);
    return {
      reservations: (t.limiter.reserve as Mock).mock.calls.length,
      transactions: t.scripted.events.filter((e) => e.kind === 'begin').length,
      statements: t.scripted.statements().length,
      invitationChecks: allowsSignUp.mock.calls.length,
    };
  }

  it('makes 3 reservations and 2 store transactions with sign up closed', async () => {
    for (const known of [true, false]) {
      const work = await workFor('closed', known, null);
      expect(work.reservations).toBe(3);
      expect(work.transactions).toBe(2);
    }
  });

  it.each(modes)('counts the same for known and unknown addresses in %s mode', async (mode) => {
    for (const cookie of [null, 'not-a-token', held]) {
      expect(await workFor(mode, true, cookie)).toEqual(await workFor(mode, false, cookie));
    }
  });

  it('checks a held invitation with one more transaction and one statement in invite_only', async () => {
    for (const known of [true, false]) {
      const without = await workFor('invite_only', known, null);
      const unparsable = await workFor('invite_only', known, 'not-a-token');
      const holding = await workFor('invite_only', known, held);
      expect(unparsable).toEqual(without);
      expect(holding.invitationChecks).toBe(1);
      expect(holding.transactions).toBe(without.transactions + 1);
      expect(holding.statements).toBe(without.statements + 1);
    }
  });
});

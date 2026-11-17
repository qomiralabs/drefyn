import { randomBytes } from 'node:crypto';
import type { UserId } from '@drefyn/tenancy';
import { beforeAll, expect, it } from 'vitest';
import type { AuthConfig } from '../../src/index.ts';
import { flowFor, newBrowser, requestCode, type Browser } from './support/email.ts';
import {
  challengesFor,
  challengesOf,
  currentCode,
  enroll,
  factorConfig,
  factorPost,
  sessionsOf,
  unusedCodesOf,
  wrongTotp,
} from './support/factor.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';
import { insideWindow, insideWindowTimeout } from './support/passwords.ts';

const fresh = harness();
let h: Harness;

async function challenged(config: AuthConfig, ip?: string) {
  const flow = flowFor(h, config);
  const email = `p-${randomBytes(4).toString('hex')}@example.com`;
  const userId = await h.user(email);
  const codes = await enroll(h, userId, config);
  const b = await signInAgain(flow, email, newBrowser(ip));
  return { flow, email, userId, codes, b };
}

async function signInAgain(flow: ReturnType<typeof flowFor>, email: string, b: Browser) {
  const sent = await requestCode(flow, b, email);
  const done = await flow.signIn.verifyEmailCode(b.context(), { code: sent?.code ?? '' });
  if (!done.ok) throw done.error;
  b.apply(done.value.setCookies);
  return b;
}

const post = (config: AuthConfig, b: Browser, kind: 'totp' | 'recovery_code', code: string) => {
  const body = factorPost(config, b, kind, code);
  return { context: b.context(), body };
};

// The 200 parallel attempts take about a second; this is ample and keeps the wait short.
const BURST_BUDGET_SECONDS = 15;

const failedOf = async (userId: UserId) =>
  Number(
    await h.sql(`select failed_attempts from app.totp_credentials where user_id = '${userId}';`),
  );

describeWithStack('second factor limits and races', () => {
  beforeAll(async () => {
    h = await fresh();
  });

  it(
    '200 parallel attempts never pass the limit',
    async () => {
      // One 5 minute window holds the whole burst, and so one hour and one day window too.
      await insideWindow(h, 300, BURST_BUDGET_SECONDS);
      const config = factorConfig({ DREFYN_AUTH_RATE_TOTP_VERIFY: '5/5m,20/1h,50/1d' });
      const c = await challenged(config);
      const challenges = challengesFor(h, config);
      const wrong = wrongTotp(await currentCode(h));
      const tries = Array.from({ length: 200 }, () => {
        const { context, body } = post(config, c.b, 'totp', wrong);
        return challenges.completeChallenge(context, body);
      });
      const codes = (await Promise.all(tries)).map((r) => (r.ok ? 'ok' : r.error.code));
      const counted = codes.filter((code) => code !== 'AUTH_RATE_LIMITED');
      expect(counted.length).toBeLessThanOrEqual(5);
      expect(codes.filter((code) => code === 'AUTH_FACTOR_INVALID').length).toBeLessThanOrEqual(5);
      expect(await sessionsOf(h, c.userId)).toBe(0);
    },
    insideWindowTimeout(BURST_BUDGET_SECONDS),
  );

  it('the challenge passes at most 5 of 200 parallel attempts', async () => {
    const config = factorConfig();
    const c = await challenged(config);
    const challenges = challengesFor(h, config);
    const wrong = wrongTotp(await currentCode(h));
    const tries = Array.from({ length: 200 }, () => {
      const { context, body } = post(config, c.b, 'totp', wrong);
      return challenges.completeChallenge(context, body);
    });
    const codes = (await Promise.all(tries)).map((r) => (r.ok ? 'ok' : r.error.code));
    expect(codes.filter((code) => code === 'AUTH_FACTOR_INVALID')).toHaveLength(5);
    expect(new Set(codes)).toEqual(
      new Set(['AUTH_FACTOR_INVALID', 'AUTH_FACTOR_CHALLENGE_EXPIRED']),
    );
    expect(
      await h.sql(`select attempts from app.factor_challenges where user_id = '${c.userId}';`),
    ).toBe('5');
    expect(await failedOf(c.userId)).toBe(5);
  });

  it('one TOTP code used twice in parallel wins once; the other is invalid', async () => {
    const config = factorConfig();
    const c = await challenged(config);
    const challenges = challengesFor(h, config);
    const code = await currentCode(h);
    const both = await Promise.all(
      [0, 1].map(() => {
        const { context, body } = post(config, c.b, 'totp', code);
        return challenges.completeChallenge(context, body);
      }),
    );
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    const lost = both.find((r) => !r.ok);
    expect(lost?.ok === false && lost.error.code).toMatch(
      /^AUTH_FACTOR_INVALID$|^AUTH_FACTOR_CHALLENGE_EXPIRED$/,
    );
    expect(await sessionsOf(h, c.userId)).toBe(1);
    // A replay in a fresh challenge is refused by the guard.
    await signInAgain(c.flow, c.email, c.b);
    const { context, body } = post(config, c.b, 'totp', code);
    const replay = await challenges.completeChallenge(context, body);
    expect(!replay.ok && replay.error.code).toBe('AUTH_FACTOR_INVALID');
  });

  it('one recovery code used twice in parallel wins once', async () => {
    const config = factorConfig();
    const c = await challenged(config);
    const challenges = challengesFor(h, config);
    const code = c.codes[0] ?? '';
    const both = await Promise.all(
      [0, 1].map(() => {
        const { context, body } = post(config, c.b, 'recovery_code', code);
        return challenges.completeChallenge(context, body);
      }),
    );
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(await unusedCodesOf(h, c.userId)).toBe(9);
    await signInAgain(c.flow, c.email, c.b);
    const { context, body } = post(config, c.b, 'recovery_code', code);
    const replay = await challenges.completeChallenge(context, body);
    expect(!replay.ok && replay.error.code).toBe('AUTH_FACTOR_INVALID');
  });

  it('two failures at 99 both persist, and the count saturates at 100', async () => {
    const config = factorConfig();
    const c = await challenged(config);
    await h.sql(
      `update app.totp_credentials set failed_attempts = 99 where user_id = '${c.userId}';`,
    );
    const challenges = challengesFor(h, config);
    const wrong = wrongTotp(await currentCode(h));
    const both = await Promise.all(
      [0, 1].map(() => {
        const { context, body } = post(config, c.b, 'totp', wrong);
        return challenges.completeChallenge(context, body);
      }),
    );
    // Neither breaks the check constraint and rolls back: one that read 99 saturates, one
    // that read the other's 100 is refused as disabled. Neither is ever unavailable.
    const answers = both.map((r) => (r.ok ? 'ok' : r.error.code));
    expect(answers).toContain('AUTH_FACTOR_INVALID');
    for (const answer of answers) {
      expect(['AUTH_FACTOR_INVALID', 'AUTH_FACTOR_DISABLED']).toContain(answer);
    }
    expect(await failedOf(c.userId)).toBe(100);
    expect(
      await h.sql(`select attempts from app.factor_challenges where user_id = '${c.userId}';`),
    ).toBe('2');
  });

  it('at 100 failures TOTP is disabled, live sessions stay, and a recovery code lifts it', async () => {
    const config = factorConfig();
    const c = await challenged(config);
    // A session made before the lockout.
    await h.sql(
      `insert into app.sessions (user_id, secret_hash, method, authenticated_at, last_seen_at, expires_at) values ('${c.userId}', '\\x${'11'.repeat(32)}', 'email', now(), now(), now() + interval '1 day');`,
    );
    const b = await signInAgain(c.flow, c.email, c.b);
    await h.sql(
      `update app.totp_credentials set failed_attempts = 99 where user_id = '${c.userId}';`,
    );
    const challenges = challengesFor(h, config);
    const wrong = post(config, b, 'totp', wrongTotp(await currentCode(h)));
    await challenges.completeChallenge(wrong.context, wrong.body);
    expect(await failedOf(c.userId)).toBe(100);
    const right = post(config, b, 'totp', await currentCode(h));
    const refused = await challenges.completeChallenge(right.context, right.body);
    expect(!refused.ok && refused.error.code).toBe('AUTH_FACTOR_DISABLED');
    expect(await sessionsOf(h, c.userId)).toBe(1);
    const recovery = post(config, b, 'recovery_code', c.codes[0] ?? '');
    const done = await challenges.completeChallenge(recovery.context, recovery.body);
    if (!done.ok) throw done.error;
    expect(await failedOf(c.userId)).toBe(0);
    expect(await sessionsOf(h, c.userId)).toBe(2);
  });

  // No wait for a window: each prefix makes 40 attempts against 10 an hour, so however a
  // window edge splits them, one side still holds 20 and is refused. The next test puts an
  // edge in the middle of every prefix to show it.
  const attack = async (edge: boolean) => {
    const config = factorConfig({
      DREFYN_AUTH_RATE_RECOVERY_CODE_VERIFY: '10/1h',
      DREFYN_AUTH_RATE_RECOVERY_CODE_VERIFY_IP: '30/1h',
    });
    const c = await challenged(config, '2001:db8:aaaa:1::1');
    const challenges = challengesFor(h, config);
    const limited = new Set<string>();
    for (const prefix of ['2001:db8:bad:1', '2001:db8:bad:2', '2001:db8:bad:3', '2001:db8:bad:4']) {
      // The attacker holds the first factor, so each sign in earns a challenge of five tries,
      // and keeps going until this network is refused.
      for (let round = 0; round < 8; round += 1) {
        // What a window edge does: every count starts again from nothing.
        if (edge && round === 4) await h.sql('delete from app.auth_rate_limits;');
        const b = await signInAgain(c.flow, c.email, newBrowser(`${prefix}::${String(round + 1)}`));
        for (let i = 0; i < 5; i += 1) {
          const { context, body } = post(config, b, 'recovery_code', '0'.repeat(24));
          const done = await challenges.completeChallenge(context, body);
          if (!done.ok && done.error.code === 'AUTH_RATE_LIMITED') limited.add(prefix);
        }
      }
    }
    expect(limited.size).toBe(4);
    const owner = await signInAgain(c.flow, c.email, newBrowser('2001:db8:aaaa:1::1'));
    const { context, body } = post(config, owner, 'recovery_code', c.codes[0] ?? '');
    const done = await challenges.completeChallenge(context, body);
    if (!done.ok) throw done.error;
    expect(await challengesOf(h, c.userId)).toBe(0);
  };

  it('an attacker across 4 /64 prefixes never stops the owner’s recovery code', async () => {
    await attack(false);
  });

  it('a window edge in the middle of each prefix still refuses all 4, and the owner gets in', async () => {
    await attack(true);
  });
});

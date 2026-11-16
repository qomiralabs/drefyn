import { randomBytes } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import { formatFactorToken } from '../../src/index.ts';
import { flowFor, newBrowser, requestCode } from './support/email.ts';
import {
  challengesFor,
  challengesOf,
  currentCode,
  enroll,
  factorConfig,
  factorPost,
  sessionsOf,
} from './support/factor.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';

const fresh = harness();
let h: Harness;

const budgets = () =>
  h.sql(
    `select coalesce(sum(count), 0) from app.auth_rate_limits where bucket in ('totp_verify', 'recovery_code_verify', 'recovery_code_verify_ip');`,
  );

describeWithStack('a forged factor cookie', () => {
  beforeAll(async () => {
    h = await fresh();
  });

  // A stranger knows the person's user id, which is not a secret. Without the secret the
  // cookie carries, nothing may be counted, locked or written: not the budgets, not the
  // challenge's attempts and not the failure count.
  it('1,000 forged posts leave both budgets, attempts and failed_attempts unchanged', async () => {
    const config = factorConfig({
      DREFYN_AUTH_RATE_TOTP_VERIFY: '5/5m,20/1h,50/1d',
      DREFYN_AUTH_RATE_RECOVERY_CODE_VERIFY: '10/1h',
      DREFYN_AUTH_RATE_RECOVERY_CODE_VERIFY_IP: '30/1h',
    });
    const flow = flowFor(h, config);
    const email = `victim-${randomBytes(3).toString('hex')}@example.com`;
    const userId = await h.user(email);
    const codes = await enroll(h, userId, config);
    const owner = newBrowser();
    const sent = await requestCode(flow, owner, email);
    const signed = await flow.signIn.verifyEmailCode(owner.context(), { code: sent?.code ?? '' });
    if (!signed.ok) throw signed.error;
    owner.apply(signed.value.setCookies);
    expect(await challengesOf(h, userId)).toBe(1);
    const before = {
      budgets: await budgets(),
      row: await h.sql(
        `select c.attempts || ':' || t.failed_attempts from app.factor_challenges c join app.totp_credentials t using (user_id) where c.user_id = '${userId}';`,
      ),
      hash: await h.sql(
        `select encode(secret_hash, 'hex') from app.factor_challenges where user_id = '${userId}';`,
      ),
    };
    const challenges = challengesFor(h, config);
    const attacker = newBrowser('192.0.2.66');
    const answers = new Set<string>();
    for (let batch = 0; batch < 20; batch += 1) {
      const posts = Array.from({ length: 50 }, (_, i) => {
        attacker.cookies.set(
          config.cookies.factor,
          formatFactorToken({ userId, secret: randomBytes(32) }),
        );
        const kind = i % 2 === 0 ? 'totp' : 'recovery_code';
        const code = kind === 'totp' ? '123456' : (codes[0] ?? '');
        const post = factorPost(config, attacker, kind, code);
        return challenges.completeChallenge(attacker.context(), post);
      });
      for (const done of await Promise.all(posts)) {
        answers.add(done.ok ? 'ok' : done.error.code);
      }
    }
    expect([...answers]).toEqual(['AUTH_FACTOR_CHALLENGE_EXPIRED']);
    expect(await budgets()).toBe(before.budgets);
    expect(
      await h.sql(
        `select c.attempts || ':' || t.failed_attempts from app.factor_challenges c join app.totp_credentials t using (user_id) where c.user_id = '${userId}';`,
      ),
    ).toBe(before.row);
    expect(
      await h.sql(
        `select encode(secret_hash, 'hex') from app.factor_challenges where user_id = '${userId}';`,
      ),
    ).toBe(before.hash);
    expect(await sessionsOf(h, userId)).toBe(0);
    // The owner's own challenge survived and still finishes.
    const done = await challenges.completeChallenge(
      owner.context(),
      factorPost(config, owner, 'totp', await currentCode(h)),
    );
    if (!done.ok) throw done.error;
    expect(await sessionsOf(h, userId)).toBe(1);
  });
});

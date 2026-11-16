import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { withUser } from '@drefyn/db';
import { beforeAll, expect, it } from 'vitest';
import { hasConfirmedFactor, lockFactor } from '../../../src/factor-rows.ts';
import { flowFor, newBrowser, requestCode } from '../support/email.ts';
import { challengesFor, enroll, factorConfig, factorPost } from '../support/factor.ts';
import { describeWithStack, harness, type Harness } from '../support/harness.ts';

// The two budgets the gate carries, measured alone so the parallel files' load is not in
// them: what the gate adds to a sign in with no factor, and a whole passed challenge.

const fresh = harness();
let h: Harness;

const ADDED_P99_MS = 3;
const COMPLETE_P99_MS = 50;
const WARMUP = 20;

const p99 = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.99 * sorted.length) - 1)] ?? NaN;
};

describeWithStack('second factor timing', () => {
  beforeAll(async () => {
    h = await fresh();
  });

  it(`startSession for a person with no factor adds under ${String(ADDED_P99_MS)} ms at p99`, async () => {
    const userId = await h.user();
    const added: number[] = [];
    for (let i = 0; i < 300 + WARMUP; i += 1) {
      // Exactly what the gate puts in front of the insert: the lock and the read.
      const took = await withUser(h.db, { userId }, async (tx) => {
        const start = performance.now();
        await lockFactor(tx, userId, 'shared');
        await hasConfirmedFactor(tx);
        return performance.now() - start;
      });
      if (i >= WARMUP) added.push(took);
    }
    console.info(`factor gate added p99 ${p99(added).toFixed(3)} ms`);
    expect(p99(added)).toBeLessThan(ADDED_P99_MS);
  });

  it(`completeChallenge stays under ${String(COMPLETE_P99_MS)} ms at p99 idle`, async () => {
    const config = factorConfig();
    const flow = flowFor(h, config);
    const challenges = challengesFor(h, config);
    const times: number[] = [];
    for (let person = 0; person < 12; person += 1) {
      const email = `t-${randomBytes(4).toString('hex')}@example.com`;
      const userId = await h.user(email);
      const codes = await enroll(h, userId, config);
      for (const code of codes) {
        const b = newBrowser();
        const sent = await requestCode(flow, b, email);
        const done = await flow.signIn.verifyEmailCode(b.context(), { code: sent?.code ?? '' });
        if (!done.ok) throw done.error;
        b.apply(done.value.setCookies);
        const body = factorPost(config, b, 'recovery_code', code);
        const context = b.context();
        const start = performance.now();
        const passed = await challenges.completeChallenge(context, body);
        const took = performance.now() - start;
        if (!passed.ok) throw passed.error;
        times.push(took);
      }
    }
    const measured = times.slice(WARMUP);
    console.info(
      `completeChallenge p99 ${p99(measured).toFixed(3)} ms over ${String(measured.length)}`,
    );
    expect(p99(measured)).toBeLessThan(COMPLETE_P99_MS);
  });
});

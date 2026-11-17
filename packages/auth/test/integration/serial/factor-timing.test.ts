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
const WARMUP = 20;

// completeChallenge is held two ways, neither on its p99. Of 100 samples the p99 is the
// second slowest, so two runner stalls failed it on CI (85, 120 and 199 ms), while a 10 ms
// slowdown added to every call still passed it on a laptop.
// Each round times the email code step and then the challenge, back to back for one person,
// so a slow stretch of the runner slows both. The median of their per round ratio ignores a
// few stalls and moves with any change that makes every challenge slower: 1.33 to 1.39 on a
// laptop, 1.94 with 5 ms added to each challenge.
const RATIO_BUDGET = 1.75;
// The 50 ms budget is for an idle machine. A shared runner is not one, so here it holds the
// tenth slowest of 100 and leaves the p99 to a quiet run, where it is printed.
const COMPLETE_P90_MS = 50;

const percentile = (values: readonly number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;
};
const p99 = (values: readonly number[]) => percentile(values, 99);

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

  it(`completeChallenge keeps within ${String(RATIO_BUDGET)} times the email code step it follows, and under ${String(COMPLETE_P90_MS)} ms at p90`, async () => {
    const config = factorConfig();
    const flow = flowFor(h, config);
    const challenges = challengesFor(h, config);
    const emailStep: number[] = [];
    const challenge: number[] = [];
    for (let person = 0; person < 12; person += 1) {
      const email = `t-${randomBytes(4).toString('hex')}@example.com`;
      const userId = await h.user(email);
      const codes = await enroll(h, userId, config);
      for (const code of codes) {
        const b = newBrowser();
        const sent = await requestCode(flow, b, email);
        const context = b.context();
        const emailStart = performance.now();
        const done = await flow.signIn.verifyEmailCode(context, { code: sent?.code ?? '' });
        const emailTook = performance.now() - emailStart;
        if (!done.ok) throw done.error;
        b.apply(done.value.setCookies);
        const body = factorPost(config, b, 'recovery_code', code);
        const factorContext = b.context();
        const start = performance.now();
        const passed = await challenges.completeChallenge(factorContext, body);
        const took = performance.now() - start;
        if (!passed.ok) throw passed.error;
        emailStep.push(emailTook);
        challenge.push(took);
      }
    }
    const measured = challenge.slice(WARMUP);
    const ratios = measured.map((took, i) => took / (emailStep[i + WARMUP] ?? NaN));
    const ratio = percentile(ratios, 50);
    const p90 = percentile(measured, 90);
    const spread = (values: readonly number[]) =>
      [50, 90, 99].map((p) => `p${String(p)} ${percentile(values, p).toFixed(2)}`).join(', ');
    // Printed for the PR.
    console.info(
      `completeChallenge over ${String(measured.length)}: ${spread(measured)} ms; email code step ${spread(emailStep.slice(WARMUP))} ms; median ratio ${ratio.toFixed(3)} (budget ${String(RATIO_BUDGET)})`,
    );
    expect(ratio).toBeLessThan(RATIO_BUDGET);
    expect(p90).toBeLessThan(COMPLETE_P90_MS);
  });
});

import { beforeAll, expect, it } from 'vitest';
import { createTestAuthMailer } from '../../../src/testing.ts';
import { configWith, flowFor, newBrowser } from '../support/email.ts';
import { describeWithStack, harness, type Harness } from '../support/harness.ts';

// The response never waits on mail, and its time says nothing about the address: a
// transport that takes 2 s per message, known and unknown addresses interleaved, every
// request from its own browser. The p99 ceiling sits far below the transport's 2 s, so a
// response that waited on mail would fail it; it is not a latency budget.

const fresh = harness();
let h: Harness;

const SAMPLES = 300;
const WARMUP = 20;

const percentile = (sorted: readonly number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;

describeWithStack('startEmailSignIn independence from mail and from the address', () => {
  beforeAll(async () => {
    h = await fresh();
  });

  it('answers at p50 within 20 ms and never waits on a 2 s transport, and known and unknown match', async () => {
    const flow = flowFor(
      h,
      configWith({ DREFYN_AUTH_SIGNUP: 'closed' }),
      {},
      createTestAuthMailer({ delayMs: 2_000 }),
    );
    await h.user('timed@example.com');
    const sends: Promise<void>[] = [];
    const once = async (email: string) => {
      const started = performance.now();
      const result = await flow.signIn.startEmailSignIn(newBrowser().context(), { email });
      const ms = performance.now() - started;
      if (!result.ok) throw result.error;
      // After the response, as the page runs it.
      sends.push(result.value.send());
      return ms;
    };
    for (let i = 0; i < WARMUP; i += 1) {
      await once('timed@example.com');
      await once('untimed@example.com');
    }
    const all: number[] = [];
    const gaps: number[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      // Alternate which goes first, so warm caches favour neither.
      let known: number;
      let unknown: number;
      if (i % 2 === 0) {
        known = await once('timed@example.com');
        unknown = await once('untimed@example.com');
      } else {
        unknown = await once('untimed@example.com');
        known = await once('timed@example.com');
      }
      all.push(known, unknown);
      gaps.push(Math.abs(known - unknown));
    }
    await Promise.all(sends);
    const sorted = [...all].sort((a, b) => a - b);
    const gapSorted = [...gaps].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p99 = percentile(sorted, 99);
    const gap = percentile(gapSorted, 50);
    // Printed for the PR.
    console.info(
      `startEmailSignIn without waiting on a 2000 ms transport: ${String(all.length)} samples, p50 ${p50.toFixed(2)} ms (at most 20), p99 ${p99.toFixed(2)} ms (under 500, far below the transport), median known/unknown gap ${gap.toFixed(3)} ms (under 2)`,
    );
    expect(p50).toBeLessThanOrEqual(20);
    expect(p99).toBeLessThanOrEqual(500);
    expect(gap).toBeLessThan(2);
    // Mail went to the known address only, after the responses.
    expect(flow.mail.sent.every((m) => m.to === 'timed@example.com')).toBe(true);
  });
});

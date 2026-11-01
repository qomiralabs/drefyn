import { beforeAll, expect, it } from 'vitest';
import { createTestAuthMailer } from '../../../src/testing.ts';
import { configWith, flowFor, newBrowser } from '../support/email.ts';
import { describeWithStack, harness, type Harness } from '../support/harness.ts';

// The response never waits on mail, and its time says nothing about the address: a
// transport that takes 2 s per message, known and unknown addresses interleaved, every
// request from its own browser.

const fresh = harness();
let h: Harness;

const SAMPLES = 300;
const WARMUP = 20;

const percentile = (sorted: readonly number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;

describeWithStack('startEmailSignIn timing', () => {
  beforeAll(async () => {
    h = await fresh();
  });

  it('answers within 50 ms at p99 with a 2 s transport, and known and unknown match', async () => {
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
      `startEmailSignIn: ${String(all.length)} samples, p50 ${p50.toFixed(2)} ms, p99 ${p99.toFixed(2)} ms, median known/unknown gap ${gap.toFixed(3)} ms, transport 2000 ms`,
    );
    expect(p99).toBeLessThanOrEqual(50);
    expect(gap).toBeLessThan(2);
    // Mail went to the known address only, after the responses.
    expect(flow.mail.sent.every((m) => m.to === 'timed@example.com')).toBe(true);
  });
});

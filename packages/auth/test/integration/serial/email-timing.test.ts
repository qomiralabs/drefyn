import { beforeAll, expect, it } from 'vitest';
import { createTestAuthMailer } from '../../../src/testing.ts';
import { configWith, flowFor, newBrowser } from '../support/email.ts';
import { describeWithStack, harness, type Harness } from '../support/harness.ts';
import { hold, inviteAddress, invitationsFor, invitingOrganization } from '../support/invite.ts';

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

  it('with a held invitation in invite_only, answers at p50 within 20 ms and p99 within 500 ms for known and unknown', async () => {
    const config = configWith({ DREFYN_AUTH_SIGNUP: 'invite_only' });
    const invitations = invitationsFor(h, config);
    const flow = flowFor(h, config, { invitations }, createTestAuthMailer({ delayMs: 2_000 }));
    await h.user('held-known@example.com');
    const { access } = await invitingOrganization(h);
    // The invitation is for someone else, so neither timed address is let in by it and the
    // known address is the only one mailed.
    const { token } = await inviteAddress(h, invitations, access, 'held-other@example.com');
    const sends: Promise<void>[] = [];
    const once = async (email: string) => {
      const b = newBrowser();
      hold(invitations, b, token);
      const started = performance.now();
      const result = await flow.signIn.startEmailSignIn(b.context(), { email });
      const ms = performance.now() - started;
      if (!result.ok) throw result.error;
      sends.push(result.value.send());
      return ms;
    };
    for (let i = 0; i < WARMUP; i += 1) {
      await once('held-known@example.com');
      await once('held-unknown@example.com');
    }
    const all: number[] = [];
    const gaps: number[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      let known: number;
      let unknown: number;
      if (i % 2 === 0) {
        known = await once('held-known@example.com');
        unknown = await once('held-unknown@example.com');
      } else {
        unknown = await once('held-unknown@example.com');
        known = await once('held-known@example.com');
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
    console.info(
      `startEmailSignIn in invite_only holding an invitation: ${String(all.length)} samples, p50 ${p50.toFixed(2)} ms (at most 20), p99 ${p99.toFixed(2)} ms (under 500), median known/unknown gap ${gap.toFixed(3)} ms (under 2)`,
    );
    expect(p50).toBeLessThanOrEqual(20);
    expect(p99).toBeLessThanOrEqual(500);
    expect(gap).toBeLessThan(2);
    expect(flow.mail.sent.every((m) => m.to === 'held-known@example.com')).toBe(true);
  });
});

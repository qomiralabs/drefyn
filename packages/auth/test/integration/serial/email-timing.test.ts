import { withAuth, withUser } from '@drefyn/db';
import { beforeAll, expect, it } from 'vitest';
import type { SessionStore } from '../../../src/index.ts';
import { createTestAuthMailer } from '../../../src/testing.ts';
import { configWith, flowFor, newBrowser, type Browser, type Flow } from '../support/email.ts';
import { describeWithStack, harness, type Harness } from '../support/harness.ts';
import { hold, inviteAddress, invitationsFor, invitingOrganization } from '../support/invite.ts';

// The response never waits on mail, and its time says nothing about the address: a
// transport that takes 2 s per message, known and unknown addresses interleaved, every
// request from its own browser. The p99 ceiling sits far below the transport's 2 s, so a
// response that waited on mail would fail it; it is not a latency budget.
//
// The address check is a shift, not a spread. Each round times known and unknown back to
// back and keeps the signed difference, and the order flips every round, so two rounds in a
// row put each address once in each slot and their mean cancels anything tied to the slot.
// A busy runner that stalls one request of most pairs moves the spread, the median of
// |known - unknown|, by the size of the stall and leaves the shift alone. A real cost on
// known addresses moves both.

const fresh = harness();
let h: Harness;

const SAMPLES = 300;
const WARMUP = 20;
const P50_BUDGET_MS = 20;
const P99_CEILING_MS = 500;
const SHIFT_BUDGET_MS = 2;
const SMALL_LEAK_MS = 4;
// About the stall a shared runner showed once, one slow request in most pairs.
const STALL_MS = 9;
const RUN_TIMEOUT_MS = 120_000;

const percentile = (sorted: readonly number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;

const sorted = (values: readonly number[]) => [...values].sort((a, b) => a - b);

// The median of the means of rounds 2k and 2k + 1, which ran in opposite orders.
const shift = (deltas: readonly number[]) => {
  const blocks: number[] = [];
  for (let i = 0; i + 1 < deltas.length; i += 2) {
    blocks.push(((deltas[i] ?? NaN) + (deltas[i + 1] ?? NaN)) / 2);
  }
  return Math.abs(percentile(sorted(blocks), 50));
};
const spread = (deltas: readonly number[]) => percentile(sorted(deltas.map(Math.abs)), 50);

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A leak on purpose: known addresses pay a little extra after the lookup.
const slowsKnown = (harnessed: Harness): SessionStore => ({
  user: (userId, work) => withUser(harnessed.db, { userId }, work),
  auth: async (work) => {
    const result = await withAuth(harnessed.authDb, work);
    const found =
      typeof result === 'object' && result !== null && 'userId' in result && result.userId !== null;
    if (found) await pause(SMALL_LEAK_MS);
    return result;
  },
});

interface Measured {
  readonly all: readonly number[];
  readonly deltas: readonly number[];
}

// Known minus unknown per round. `browser` makes each request's browser; `stall` is added
// to every second request whatever its address, the way a busy runner adds it.
async function measure(
  flow: Flow,
  known: string,
  unknown: string,
  options: { readonly browser?: () => Browser; readonly stall?: number } = {},
): Promise<Measured> {
  const browser = options.browser ?? (() => newBrowser());
  const sends: Promise<void>[] = [];
  let count = 0;
  const once = async (email: string) => {
    const b = browser();
    const started = performance.now();
    if (options.stall !== undefined && count % 2 === 1) await pause(options.stall);
    count += 1;
    const result = await flow.signIn.startEmailSignIn(b.context(), { email });
    const ms = performance.now() - started;
    if (!result.ok) throw result.error;
    // After the response, as the page runs it.
    sends.push(result.value.send());
    return ms;
  };
  for (let i = 0; i < WARMUP; i += 1) {
    await once(known);
    await once(unknown);
  }
  count = 0;
  const all: number[] = [];
  const deltas: number[] = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    let k: number;
    let u: number;
    if (i % 2 === 0) {
      k = await once(known);
      u = await once(unknown);
    } else {
      u = await once(unknown);
      k = await once(known);
    }
    all.push(k, u);
    deltas.push(k - u);
  }
  await Promise.all(sends);
  return { all: sorted(all), deltas };
}

const summary = ({ all, deltas }: Measured) =>
  `${String(all.length)} samples, p50 ${percentile(all, 50).toFixed(2)} ms (at most ${String(P50_BUDGET_MS)}), p99 ${percentile(all, 99).toFixed(2)} ms (under ${String(P99_CEILING_MS)}), known/unknown shift ${shift(deltas).toFixed(3)} ms (budget ${String(SHIFT_BUDGET_MS)}), spread ${spread(deltas).toFixed(3)} ms`;

describeWithStack('startEmailSignIn independence from mail and from the address', () => {
  beforeAll(async () => {
    h = await fresh();
    await h.user('timed@example.com');
  });

  it(
    'answers at p50 within 20 ms and never waits on a 2 s transport, and known and unknown match',
    async () => {
      const flow = flowFor(
        h,
        configWith({ DREFYN_AUTH_SIGNUP: 'closed' }),
        {},
        createTestAuthMailer({ delayMs: 2_000 }),
      );
      const measured = await measure(flow, 'timed@example.com', 'untimed@example.com');
      // Printed for the PR.
      console.info(`startEmailSignIn without waiting on a 2000 ms transport: ${summary(measured)}`);
      expect(percentile(measured.all, 50)).toBeLessThanOrEqual(P50_BUDGET_MS);
      expect(percentile(measured.all, 99)).toBeLessThanOrEqual(P99_CEILING_MS);
      expect(shift(measured.deltas)).toBeLessThan(SHIFT_BUDGET_MS);
      // Mail went to the known address only, after the responses.
      expect(flow.mail.sent.every((m) => m.to === 'timed@example.com')).toBe(true);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'with a held invitation in invite_only, answers at p50 within 20 ms and p99 within 500 ms for known and unknown',
    async () => {
      const config = configWith({ DREFYN_AUTH_SIGNUP: 'invite_only' });
      const invitations = invitationsFor(h, config);
      const flow = flowFor(h, config, { invitations }, createTestAuthMailer({ delayMs: 2_000 }));
      await h.user('held-known@example.com');
      const { access } = await invitingOrganization(h);
      // The invitation is for someone else, so neither timed address is let in by it and the
      // known address is the only one mailed.
      const { token } = await inviteAddress(h, invitations, access, 'held-other@example.com');
      const measured = await measure(flow, 'held-known@example.com', 'held-unknown@example.com', {
        browser: () => {
          const b = newBrowser();
          hold(invitations, b, token);
          return b;
        },
      });
      console.info(`startEmailSignIn in invite_only holding an invitation: ${summary(measured)}`);
      expect(percentile(measured.all, 50)).toBeLessThanOrEqual(P50_BUDGET_MS);
      expect(percentile(measured.all, 99)).toBeLessThanOrEqual(P99_CEILING_MS);
      expect(shift(measured.deltas)).toBeLessThan(SHIFT_BUDGET_MS);
      expect(flow.mail.sent.every((m) => m.to === 'held-known@example.com')).toBe(true);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'control: with 4 ms added on known addresses the shift reaches the budget',
    async () => {
      const flow = flowFor(h, configWith({ DREFYN_AUTH_SIGNUP: 'closed' }), {
        store: slowsKnown(h),
      });
      const measured = await measure(flow, 'timed@example.com', 'untimed@example.com');
      // Printed for the PR.
      console.info(`control, ${String(SMALL_LEAK_MS)} ms leak on known: ${summary(measured)}`);
      expect(shift(measured.deltas)).toBeGreaterThanOrEqual(SHIFT_BUDGET_MS);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'control: a 9 ms stall on every second request, whatever the address, leaves the shift under budget',
    async () => {
      const flow = flowFor(h, configWith({ DREFYN_AUTH_SIGNUP: 'closed' }));
      const measured = await measure(flow, 'timed@example.com', 'untimed@example.com', {
        stall: STALL_MS,
      });
      // Printed for the PR.
      console.info(`control, ${String(STALL_MS)} ms stall by slot: ${summary(measured)}`);
      // The spread sees the stall, as the old check did on the busy runner.
      expect(spread(measured.deltas)).toBeGreaterThanOrEqual(SHIFT_BUDGET_MS);
      expect(shift(measured.deltas)).toBeLessThan(SHIFT_BUDGET_MS);
    },
    RUN_TIMEOUT_MS,
  );
});

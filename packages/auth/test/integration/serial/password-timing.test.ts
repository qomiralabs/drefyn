import { beforeAll, expect, it } from 'vitest';
import { ARGON2_FLOOR, type Argon2Params, type PasswordHasher } from '../../../src/index.ts';
import { newBrowser } from '../support/email.ts';
import { describeWithStack, harness, type Harness } from '../support/harness.ts';
import {
  hasherAt,
  passwordConfig,
  passwordFlow,
  personWithPassword,
  type PasswordFlow,
} from '../support/passwords.ts';

// Real parameters: the gap is about what the hash costs. Every failure kind is interleaved,
// each from its own browser, and the stored hashes include ones at the floor while the
// configured parameters sit above it, so a cheaper old hash cannot answer faster.

const fresh = harness();
let h: Harness;

const SAMPLES = Number(process.env['DREFYN_AUTH_TIMING_SAMPLES'] ?? '150');
const WARMUP = 10;
const CURRENT: Argon2Params = { memoryKib: 24_576, passes: 2, parallelism: 1 };
const P50_BUDGET_MS = 60;
const GAP_BUDGET_MS = 2;
const LEAK_FLOOR_MS = 8;
const SMALL_LEAK_MS = 4;
const RUN_TIMEOUT_MS = 180_000;

const percentile = (sorted: readonly number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;

const sorted = (values: readonly number[]) => [...values].sort((a, b) => a - b);

// Signed, so jitter cancels. The median of |d| measures jitter and does not fall with samples.
const shift = (deltas: readonly number[]) => Math.abs(percentile(sorted(deltas), 50));
const jitter = (deltas: readonly number[]) => percentile(sorted(deltas.map(Math.abs)), 50);

// Both controls leak on purpose: a check that stopped seeing a leak fails on them.
const skipsDummy = (real: PasswordHasher): PasswordHasher => ({
  ...real,
  check: (phc, password) =>
    phc === null
      ? Promise.resolve({ matched: false, rehash: false, readable: true })
      : real.check(phc, password),
});
const slowsKnown = (real: PasswordHasher): PasswordHasher => ({
  ...real,
  check: async (phc, password) => {
    const result = await real.check(phc, password);
    if (phc !== null) await new Promise((resolve) => setTimeout(resolve, SMALL_LEAK_MS));
    return result;
  },
});

const once = async (flow: PasswordFlow, email: string) => {
  const b = newBrowser();
  const form = flow.signIn.passwordForm(b.context());
  b.apply(form.setCookies);
  const started = performance.now();
  const result = await flow.signIn.signInWithPassword(b.context(), {
    email,
    password: 'a wrong guess of some length',
    csrf: form.csrf,
  });
  const ms = performance.now() - started;
  if (result.ok || result.error.code !== 'AUTH_CREDENTIALS_INVALID') {
    throw new Error('expected a credentials refusal');
  }
  return ms;
};

// Each kind's time per round, and its signed difference from unknown in that same round.
const measure = async (flow: PasswordFlow, kinds: Readonly<Record<string, string>>) => {
  const names = Object.keys(kinds);
  const emailOf = (n: string) => kinds[n] ?? '';
  for (let i = 0; i < WARMUP; i += 1) for (const n of names) await once(flow, emailOf(n));
  const times: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, []]));
  const deltas: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, []]));
  for (let i = 0; i < SAMPLES; i += 1) {
    // Rotate the order so warm caches favour none.
    const order = names.map((_, j) => names[(i + j) % names.length] ?? 'unknown');
    const round: Record<string, number> = {};
    for (const n of order) round[n] = await once(flow, emailOf(n));
    for (const n of names) {
      times[n]?.push(round[n] ?? NaN);
      deltas[n]?.push((round[n] ?? NaN) - (round['unknown'] ?? NaN));
    }
  }
  return { times, deltas };
};

describeWithStack('password sign in timing says nothing about the address', () => {
  const config = passwordConfig({ DREFYN_AUTH_SIGNUP: 'closed' });
  const realHasher = () => hasherAt(CURRENT, ARGON2_FLOOR);
  let current: PasswordFlow;
  let wrongCurrent: string;
  const unknown = 'timed-nobody@example.com';

  beforeAll(async () => {
    h = await fresh();
    current = passwordFlow(h, config, realHasher());
    wrongCurrent = (await personWithPassword(h, current, 'the current parameters one')).email;
  });

  it(
    'unknown, no password, wrong password at current and at older parameters: signed median gap under 2 ms',
    async () => {
      const old = passwordFlow(h, config, hasherAt(ARGON2_FLOOR, ARGON2_FLOOR));
      const atFloor = await personWithPassword(h, old, 'the older parameters one');
      const noPassword = 'timed-nopw@example.com';
      await h.user(noPassword);
      const kinds = { unknown, noPassword, wrongCurrent, wrongOlder: atFloor.email };
      const names = Object.keys(kinds);
      const { times, deltas } = await measure(current, kinds);
      const all = sorted(names.flatMap((n) => times[n] ?? []));
      const compared = ['noPassword', 'wrongCurrent', 'wrongOlder'];
      const p50s = names
        .map((n) => `${n} p50 ${percentile(sorted(times[n] ?? []), 50).toFixed(2)} ms`)
        .join(', ');
      const shifts = compared
        .map(
          (n) =>
            `${n} ${shift(deltas[n] ?? []).toFixed(3)} ms (jitter ${jitter(deltas[n] ?? []).toFixed(3)} ms)`,
        )
        .join(', ');
      // Printed for the PR.
      console.info(
        `signInWithPassword refusals at m=${String(CURRENT.memoryKib)},t=${String(CURRENT.passes)} (older hashes at the floor): ${String(all.length)} samples, overall p50 ${percentile(all, 50).toFixed(2)} ms (at most ${String(P50_BUDGET_MS)}), p99 ${percentile(all, 99).toFixed(2)} ms; ${p50s}; shift from unknown (each under ${String(GAP_BUDGET_MS)}): ${shifts}`,
      );
      expect(percentile(all, 50)).toBeLessThanOrEqual(P50_BUDGET_MS);
      for (const n of compared) {
        expect(shift(deltas[n] ?? [])).toBeLessThan(GAP_BUDGET_MS);
      }
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'control: with the dummy hash skipped the gap is at least 8 ms',
    async () => {
      const flow = passwordFlow(h, config, skipsDummy(realHasher()));
      const { deltas } = await measure(flow, { unknown, wrongCurrent });
      const seen = shift(deltas['wrongCurrent'] ?? []);
      // Printed for the PR.
      console.info(`control, dummy hash skipped: shift ${seen.toFixed(3)} ms`);
      expect(seen).toBeGreaterThanOrEqual(LEAK_FLOOR_MS);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'control: with 4 ms added on known addresses the gap reaches the budget',
    async () => {
      const flow = passwordFlow(h, config, slowsKnown(realHasher()));
      const { deltas } = await measure(flow, { unknown, wrongCurrent });
      const seen = shift(deltas['wrongCurrent'] ?? []);
      // Printed for the PR.
      console.info(`control, ${String(SMALL_LEAK_MS)} ms leak: shift ${seen.toFixed(3)} ms`);
      expect(seen).toBeGreaterThanOrEqual(GAP_BUDGET_MS);
    },
    RUN_TIMEOUT_MS,
  );
});

import { beforeAll, expect, it } from 'vitest';
import { ARGON2_FLOOR, type Argon2Params } from '../../../src/index.ts';
import { newBrowser } from '../support/email.ts';
import { describeWithStack, harness, type Harness } from '../support/harness.ts';
import {
  hasherAt,
  passwordConfig,
  passwordFlow,
  personWithPassword,
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

const percentile = (sorted: readonly number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;

describeWithStack('password sign in timing says nothing about the address', () => {
  beforeAll(async () => {
    h = await fresh();
  });

  it('unknown, no password, wrong password at current and at older parameters: median gap under 2 ms', async () => {
    const config = passwordConfig({ DREFYN_AUTH_SIGNUP: 'closed' });
    const old = passwordFlow(h, config, hasherAt(ARGON2_FLOOR, ARGON2_FLOOR));
    const current = passwordFlow(h, config, hasherAt(CURRENT, ARGON2_FLOOR));
    const atCurrent = await personWithPassword(h, current, 'the current parameters one');
    const atFloor = await personWithPassword(h, old, 'the older parameters one');
    const noPassword = 'timed-nopw@example.com';
    await h.user(noPassword);
    const kinds = {
      unknown: 'timed-nobody@example.com',
      noPassword,
      wrongCurrent: atCurrent.email,
      wrongOlder: atFloor.email,
    } as const;
    const once = async (email: string) => {
      const b = newBrowser();
      const form = current.signIn.passwordForm(b.context());
      b.apply(form.setCookies);
      const started = performance.now();
      const result = await current.signIn.signInWithPassword(b.context(), {
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
    const names = Object.keys(kinds) as (keyof typeof kinds)[];
    for (let i = 0; i < WARMUP; i += 1) for (const n of names) await once(kinds[n]);
    const times: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, []]));
    const gaps: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, []]));
    for (let i = 0; i < SAMPLES; i += 1) {
      // Rotate the order so warm caches favour none.
      const order = names.map((_, j) => names[(i + j) % names.length] ?? 'unknown');
      const round: Record<string, number> = {};
      for (const n of order) round[n] = await once(kinds[n]);
      for (const n of names) {
        times[n]?.push(round[n] ?? NaN);
        gaps[n]?.push(Math.abs((round[n] ?? NaN) - (round['unknown'] ?? NaN)));
      }
    }
    const all = names.flatMap((n) => times[n] ?? []).sort((a, b) => a - b);
    const median = (n: string) =>
      percentile(
        [...(gaps[n] ?? [])].sort((a, b) => a - b),
        50,
      );
    const line = names
      .map(
        (n) =>
          `${n} p50 ${percentile(
            [...(times[n] ?? [])].sort((a, b) => a - b),
            50,
          ).toFixed(2)} ms`,
      )
      .join(', ');
    // Printed for the PR.
    console.info(
      `signInWithPassword refusals at m=${String(CURRENT.memoryKib)},t=${String(CURRENT.passes)} (older hashes at the floor): ${String(all.length)} samples, overall p50 ${percentile(all, 50).toFixed(2)} ms (at most ${String(P50_BUDGET_MS)}), p99 ${percentile(all, 99).toFixed(2)} ms; ${line}; median gap to unknown: no password ${median('noPassword').toFixed(3)} ms, wrong ${median('wrongCurrent').toFixed(3)} ms, wrong at older parameters ${median('wrongOlder').toFixed(3)} ms (each under ${String(GAP_BUDGET_MS)})`,
    );
    expect(percentile(all, 50)).toBeLessThanOrEqual(P50_BUDGET_MS);
    for (const n of ['noPassword', 'wrongCurrent', 'wrongOlder']) {
      expect(median(n)).toBeLessThan(GAP_BUDGET_MS);
    }
  });
});

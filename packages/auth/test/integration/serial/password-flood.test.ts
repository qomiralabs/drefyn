import { pbkdf2 } from 'node:crypto';
import { availableParallelism, loadavg } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { beforeAll, expect, it } from 'vitest';
import { ARGON2_FLOOR, createEmailSignIn } from '../../../src/index.ts';
import { createTestAuthMailer } from '../../../src/testing.ts';
import { newBrowser } from '../support/email.ts';
import { describeWithStack, harness, type Harness } from '../support/harness.ts';
import { hasherAt, loggerFor, passwordConfig, passwordFlow } from '../support/passwords.ts';

// The password endpoint flooded from 1,000 addresses at the default parameters, the hash
// gate at its default of 4 and a 16 thread pool, while email code sign ins and thread pool probes
// run beside it. Four hashes fill a 4 vCPU runner, so CI holds the email median and tail to
// ceilings, not to the idle budget, which #130's timing test keeps. The thread pool wait is
// held to its median budget and a 50 ms tail. The printed line carries the machine's state.

const fresh = harness();
let h: Harness;

const EMAIL_SAMPLES = 200;
const DNS_SAMPLES = 200;
const FLOOD_ADDRESSES = 1_000;
const FLOOD_EMAIL_P50_CEILING_MS = 100;
const IDLE_EMAIL_SAMPLES = 50;
// What hasherAt gives the gate, the default DREFYN_AUTH_PASSWORD_HASH_CONCURRENCY.
const HASH_CONCURRENCY = 4;
const EMAIL_P99_CEILING_MS = 500;
const DNS_EXTRA_BUDGET_MS = 5;
const DNS_EXTRA_P99_CEILING_MS = 50;
// The control must move the probe at least this much, or the probe sees nothing.
const CONTROL_RISE_MS = 10;
// Enough pbkdf2 rounds that each job holds a pool thread for tens of milliseconds.
const HEAVY_ITERATIONS = 200_000;

const percentile = (sorted: readonly number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;
const sorted = (xs: readonly number[]) => [...xs].sort((a, b) => a - b);

// A one iteration PBKDF2 does almost no work, so its time is the wait for a libuv thread:
// the same pool dns.lookup queues on. Raw DNS is kept out of this package by lint.
function poolProbe(iterations = 1): Promise<void> {
  return new Promise((resolve, reject) => {
    pbkdf2('probe', 'salt', iterations, 32, 'sha256', (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}

const load = () =>
  loadavg()
    .map((n) => n.toFixed(2))
    .join(' ');

async function timeEmail(
  email: { startEmailSignIn: ReturnType<typeof createEmailSignIn>['startEmailSignIn'] },
  samples: number,
): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    const started = performance.now();
    const result = await email.startEmailSignIn(newBrowser().context(), {
      email: 'flooded-person@example.com',
    });
    out.push(performance.now() - started);
    if (!result.ok) throw result.error;
  }
  return out;
}

async function timeDns(samples: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    const started = performance.now();
    await poolProbe();
    out.push(performance.now() - started);
  }
  return out;
}

describeWithStack('email code sign in while the password endpoint is flooded', () => {
  beforeAll(async () => {
    h = await fresh();
  });

  it('email start stays under its flood ceilings and the thread pool wait dns.lookup would see stays under 5 ms at the median', async () => {
    const loadBefore = load();
    expect(process.env['UV_THREADPOOL_SIZE']).toBe('16');
    const config = passwordConfig({ DREFYN_AUTH_SIGNUP: 'closed' });
    const passwords = passwordFlow(h, config, hasherAt(ARGON2_FLOOR, ARGON2_FLOOR));
    const mail = createTestAuthMailer();
    const email = createEmailSignIn(config, {
      db: h.db,
      authDb: h.authDb,
      logger: loggerFor(h),
      mailer: mail.mailer,
      sessions: passwords.sessions,
    });
    await h.user('flooded-person@example.com');
    const dnsQuiet = await timeDns(DNS_SAMPLES);
    const idleEmail = sorted(await timeEmail(email, IDLE_EMAIL_SAMPLES));

    // Control: fill every pool thread directly. If the probe does not slow down, it is not
    // measuring the pool and the flood numbers below mean nothing.
    let saturating = true;
    const hog = async () => {
      while (saturating) await poolProbe(HEAVY_ITERATIONS);
    };
    const hogs = Array.from({ length: 32 }, hog);
    const dnsControl = await timeDns(40);
    saturating = false;
    await Promise.all(hogs);
    const rise = percentile(sorted(dnsControl), 50) - percentile(sorted(dnsQuiet), 50);

    let flooding = true;
    const outcomes = new Map<string, number>();
    const attacker = async (worker: number) => {
      let i = worker;
      while (flooding) {
        const b = newBrowser(`2001:db8:${(i % 4096).toString(16)}::1`);
        const result = await (async () => {
          const form = passwords.signIn.passwordForm(b.context());
          b.apply(form.setCookies);
          return passwords.signIn.signInWithPassword(b.context(), {
            email: `flood${String(i % FLOOD_ADDRESSES)}@example.com`,
            password: 'a flood of wrong guesses',
            csrf: form.csrf,
          });
        })();
        const code = result.ok ? 'ok' : result.error.code;
        outcomes.set(code, (outcomes.get(code) ?? 0) + 1);
        i += 68;
      }
    };
    // As many attackers as hash slots plus queue: the gate stays full, and the database sees
    // the attempt rate the hashes allow, as it would behind a real endpoint.
    const flood = Array.from({ length: 68 }, (_, w) => attacker(w));
    await new Promise((resolve) => setTimeout(resolve, 500));

    const loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    const emailTimes = await timeEmail(email, EMAIL_SAMPLES);
    const dnsFlooded = await timeDns(DNS_SAMPLES);
    loop.disable();
    flooding = false;
    await Promise.all(flood);
    const loadAfter = load();

    const e = sorted(emailTimes);
    const extra = percentile(sorted(dnsFlooded), 50) - percentile(sorted(dnsQuiet), 50);
    const extra99 = percentile(sorted(dnsFlooded), 99) - percentile(sorted(dnsQuiet), 99);
    console.info(
      `machine: ${String(availableParallelism())} cpus, hash concurrency ${String(HASH_CONCURRENCY)}, load average before ${loadBefore}, after ${loadAfter}; idle startEmailSignIn p50 ${percentile(idleEmail, 50).toFixed(2)} ms (${String(IDLE_EMAIL_SAMPLES)} samples); event loop delay p99 under flood ${(loop.percentile(99) / 1e6).toFixed(2)} ms. ` +
        `flood from ${String(FLOOD_ADDRESSES)} addresses (${[...outcomes].map(([k, v]) => `${k} ${String(v)}`).join(', ')}): startEmailSignIn ${String(e.length)} samples, p50 ${percentile(e, 50).toFixed(2)} ms (ceiling ${String(FLOOD_EMAIL_P50_CEILING_MS)}), p99 ${percentile(e, 99).toFixed(2)} ms (ceiling ${String(EMAIL_P99_CEILING_MS)}; target 50 on quiet hardware); thread pool wait (as dns.lookup sees it) extra p50 ${extra.toFixed(3)} ms (under ${String(DNS_EXTRA_BUDGET_MS)}), extra p99 ${extra99.toFixed(3)} ms (at most ${String(DNS_EXTRA_P99_CEILING_MS)}); control with the pool saturated raised the probe p50 by ${rise.toFixed(2)} ms (at least ${String(CONTROL_RISE_MS)})`,
    );
    expect(outcomes.get('AUTH_CREDENTIALS_INVALID') ?? 0).toBeGreaterThan(0);
    expect(percentile(e, 50)).toBeLessThanOrEqual(FLOOD_EMAIL_P50_CEILING_MS);
    expect(percentile(e, 99)).toBeLessThanOrEqual(EMAIL_P99_CEILING_MS);
    expect(rise).toBeGreaterThanOrEqual(CONTROL_RISE_MS);
    expect(extra).toBeLessThan(DNS_EXTRA_BUDGET_MS);
    expect(extra99).toBeLessThanOrEqual(DNS_EXTRA_P99_CEILING_MS);
  });
});

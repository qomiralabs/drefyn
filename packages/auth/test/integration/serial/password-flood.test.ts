import { pbkdf2 } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import { ARGON2_FLOOR, createEmailSignIn } from '../../../src/index.ts';
import { createTestAuthMailer } from '../../../src/testing.ts';
import { newBrowser } from '../support/email.ts';
import { describeWithStack, harness, type Harness } from '../support/harness.ts';
import { hasherAt, loggerFor, passwordConfig, passwordFlow } from '../support/passwords.ts';

// The password endpoint flooded from 1,000 addresses at the default parameters, the hash
// gate at its default of 4 and a 16 thread pool, while email code sign ins and thread pool probes
// run beside it. CI checks the email median and a far ceiling, and the median thread pool wait;
// the 50 ms email p99 target is read on quiet hardware from the printed line.

const fresh = harness();
let h: Harness;

const EMAIL_SAMPLES = 200;
const DNS_SAMPLES = 200;
const FLOOD_ADDRESSES = 1_000;
const EMAIL_P50_BUDGET_MS = 20;
const EMAIL_P99_CEILING_MS = 500;
const DNS_EXTRA_BUDGET_MS = 5;

const percentile = (sorted: readonly number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;
const sorted = (xs: readonly number[]) => [...xs].sort((a, b) => a - b);

// A one iteration PBKDF2 does almost no work, so its time is the wait for a libuv thread:
// the same pool dns.lookup queues on. Raw DNS is kept out of this package by lint.
function poolProbe(): Promise<void> {
  return new Promise((resolve, reject) => {
    pbkdf2('probe', 'salt', 1, 32, 'sha256', (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
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

  it('email start stays within budget and the thread pool wait dns.lookup would see adds under 5 ms at the median', async () => {
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

    const emailTimes: number[] = [];
    for (let i = 0; i < EMAIL_SAMPLES; i += 1) {
      const started = performance.now();
      const result = await email.startEmailSignIn(newBrowser().context(), {
        email: 'flooded-person@example.com',
      });
      emailTimes.push(performance.now() - started);
      if (!result.ok) throw result.error;
    }
    const dnsFlooded = await timeDns(DNS_SAMPLES);
    flooding = false;
    await Promise.all(flood);

    const e = sorted(emailTimes);
    const extra = percentile(sorted(dnsFlooded), 50) - percentile(sorted(dnsQuiet), 50);
    const extra99 = percentile(sorted(dnsFlooded), 99) - percentile(sorted(dnsQuiet), 99);
    console.info(
      `flood from ${String(FLOOD_ADDRESSES)} addresses (${[...outcomes].map(([k, v]) => `${k} ${String(v)}`).join(', ')}): startEmailSignIn ${String(e.length)} samples, p50 ${percentile(e, 50).toFixed(2)} ms (at most ${String(EMAIL_P50_BUDGET_MS)}), p99 ${percentile(e, 99).toFixed(2)} ms (ceiling ${String(EMAIL_P99_CEILING_MS)}; target 50 on quiet hardware); thread pool wait (as dns.lookup sees it) extra p50 ${extra.toFixed(3)} ms (under ${String(DNS_EXTRA_BUDGET_MS)}), extra p99 ${extra99.toFixed(3)} ms`,
    );
    expect(outcomes.get('AUTH_CREDENTIALS_INVALID') ?? 0).toBeGreaterThan(0);
    expect(percentile(e, 50)).toBeLessThanOrEqual(EMAIL_P50_BUDGET_MS);
    expect(percentile(e, 99)).toBeLessThanOrEqual(EMAIL_P99_CEILING_MS);
    expect(extra).toBeLessThan(DNS_EXTRA_BUDGET_MS);
  });
});

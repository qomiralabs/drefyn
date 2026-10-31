import { beforeAll, expect, it } from 'vitest';
import type { CookieSpec } from '../../src/index.ts';
import { configWith, flowFor, newBrowser, type Flow } from './support/email.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';

const fresh = harness();
let h: Harness;

// What reaches the browser, with the one random value (a new pre cookie) reduced to its
// shape. Everything else must be equal byte for byte.
function wire(result: Awaited<ReturnType<Flow['signIn']['startEmailSignIn']>>): string {
  if (!result.ok) {
    return JSON.stringify({
      ok: false,
      code: result.error.code,
      retryAfterSeconds: result.error.retryAfterSeconds ?? null,
      message: result.error.message,
    });
  }
  const { setCookies, ...rest } = result.value;
  return JSON.stringify({
    ok: true,
    keys: Object.keys(rest).sort(),
    cookies: setCookies.map((c: CookieSpec) => ({
      name: c.name,
      maxAgeSeconds: c.maxAgeSeconds,
      valueLength: c.value.length,
    })),
  });
}

describeWithStack('email sign in parity against Postgres', () => {
  beforeAll(async () => {
    h = await fresh();
  });

  it('known, unknown and closed mode addresses get identical responses and cookies', async () => {
    const known = await h.user('known@example.com');
    expect(known).toBeTruthy();
    const open = flowFor(h, configWith({ DREFYN_AUTH_SIGNUP: 'open' }));
    const invite = flowFor(h, configWith({ DREFYN_AUTH_SIGNUP: 'invite_only' }));
    const closed = flowFor(h, configWith({ DREFYN_AUTH_SIGNUP: 'closed' }));
    const answers: string[] = [];
    for (const flow of [open, invite, closed]) {
      for (const email of ['known@example.com', 'nobody@example.com']) {
        // A browser with no cookies, and one that already holds a pre sign in cookie.
        const b = newBrowser();
        answers.push(wire(await flow.signIn.startEmailSignIn(b.context(), { email })));
        const first = await flow.signIn.startEmailSignIn(b.context(), { email });
        if (first.ok) b.apply(first.value.setCookies);
        answers.push(wire(await flow.signIn.startEmailSignIn(b.context(), { email })));
      }
    }
    const fresh_ = answers.filter((_, i) => i % 2 === 0);
    const holding = answers.filter((_, i) => i % 2 === 1);
    expect(new Set(fresh_).size).toBe(1);
    expect(new Set(holding).size).toBe(1);
    expect(fresh_[0]).toContain('"ok":true');
  });

  it('known and unknown addresses meet the same send limits with the same refusal', async () => {
    await h.user('limited@example.com');
    const flow = flowFor(
      h,
      configWith({ DREFYN_AUTH_SIGNUP: 'closed', DREFYN_AUTH_RATE_EMAIL_SEND: '3/10m,10/1d' }),
    );
    const run = async (email: string) => {
      const b = newBrowser();
      const out: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        out.push(wire(await flow.signIn.startEmailSignIn(b.context(), { email })));
      }
      return out;
    };
    const knownRun = await run('limited@example.com');
    const unknownRun = await run('stranger@example.com');
    expect(knownRun).toEqual(unknownRun);
    expect(knownRun.slice(3).every((w) => w.includes('AUTH_RATE_LIMITED'))).toBe(true);
  });
});

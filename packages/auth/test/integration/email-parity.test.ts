import { beforeAll, expect, it } from 'vitest';
import {
  configWith,
  expectSameWire,
  flowFor,
  insideOneWindow,
  newBrowser,
  wireOf,
} from './support/email.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';

const fresh = harness();
let h: Harness;

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
    const answers: ReturnType<typeof wireOf>[] = [];
    for (const flow of [open, invite, closed]) {
      for (const email of ['known@example.com', 'nobody@example.com']) {
        // A browser with no cookies, and one that already holds a pre sign in cookie.
        const b = newBrowser();
        answers.push(wireOf(await flow.signIn.startEmailSignIn(b.context(), { email })));
        const first = await flow.signIn.startEmailSignIn(b.context(), { email });
        if (first.ok) b.apply(first.value.setCookies);
        answers.push(wireOf(await flow.signIn.startEmailSignIn(b.context(), { email })));
      }
    }
    const shapes = answers.map((w) => w.shape);
    const fresh_ = shapes.filter((_, i) => i % 2 === 0);
    const holding = shapes.filter((_, i) => i % 2 === 1);
    expect(new Set(fresh_).size).toBe(1);
    expect(new Set(holding).size).toBe(1);
    expect(answers.every((w) => w.ok)).toBe(true);
  });

  it('known and unknown addresses meet the same send limits with the same refusal', async () => {
    await h.user('limited@example.com');
    const flow = flowFor(
      h,
      configWith({ DREFYN_AUTH_SIGNUP: 'closed', DREFYN_AUTH_RATE_EMAIL_SEND: '3/10m,10/1d' }),
    );
    await insideOneWindow(h, 30);
    const run = async (email: string) => {
      const b = newBrowser();
      const out: ReturnType<typeof wireOf>[] = [];
      for (let i = 0; i < 5; i += 1) {
        out.push(wireOf(await flow.signIn.startEmailSignIn(b.context(), { email })));
      }
      return out;
    };
    const knownRun = await run('limited@example.com');
    const unknownRun = await run('stranger@example.com');
    knownRun.forEach((w, i) => {
      const other = unknownRun[i];
      if (other === undefined) throw new Error('runs differ in length');
      expectSameWire(w, other);
    });
    expect(knownRun.map((w) => w.ok)).toEqual([true, true, true, false, false]);
    expect(knownRun[3]?.shape).toContain('AUTH_RATE_LIMITED');
  });
});

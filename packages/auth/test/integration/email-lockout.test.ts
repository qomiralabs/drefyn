import { beforeAll, describe, expect, it } from 'vitest';
import type { AuthMetricName, CookieSpec } from '../../src/index.ts';
import {
  flowFor,
  newBrowser,
  requestCode,
  wrongCode,
  type Browser,
  type Flow,
} from './support/email.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';
import { parseAuthConfig } from '../../src/index.ts';
import { validEnv } from '../support.ts';
import { randomBytes } from 'node:crypto';

// Security review M1 and R4: strangers with many /64 prefixes and their own browser exhaust
// every limit they can reach for one address, and the person still signs in by code from
// their own browser, device cookie and address. The real limiter and the real database
// clock; the client address goes in only as the resolved address the wrapper fills.

const fresh = harness();

const VICTIM_IP = '2001:db8:a::1';
const FRESH_IP = '2001:db8:fe::1';
const attackerIp = (prefix: number, host = 1) =>
  `2001:db8:bad:${prefix.toString(16)}::${String(host)}`;
const shadowIp = (prefix: number, host = 1) =>
  `2001:db8:5ad:${prefix.toString(16)}::${String(host)}`;

type Start = Awaited<ReturnType<Flow['signIn']['startEmailSignIn']>>;

// What the browser sees, with a new random cookie value reduced to its length.
function wire(result: Start): string {
  if (!result.ok) {
    return JSON.stringify({
      code: result.error.code,
      retryAfterSeconds: result.error.retryAfterSeconds ?? null,
      message: result.error.message,
    });
  }
  const { setCookies, ...rest } = result.value;
  return JSON.stringify({
    keys: Object.keys(rest).sort(),
    cookies: setCookies.map((c: CookieSpec) => [c.name, c.maxAgeSeconds, c.value.length]),
  });
}

describe.each([4, 16])('with %i attacker prefixes', (prefixes) => {
  describeWithStack('the address ceiling is not a remote lockout', () => {
    let h: Harness;
    let flow: Flow;
    const metrics: AuthMetricName[] = [];

    beforeAll(async () => {
      h = await fresh();
      // Defaults for every bucket but the ceiling, set where this many prefixes provably reach
      // it inside one window (three sends per prefix get past the per prefix limit).
      const config = parseAuthConfig({
        ...validEnv(randomBytes(32).toString('base64url')),
        DREFYN_AUTH_SIGNUP: 'closed',
        DREFYN_AUTH_RATE_EMAIL_SEND_ADDRESS_CEILING: `${String(prefixes * 2)}/1d`,
      });
      flow = flowFor(h, config, {
        metrics: {
          increment(name) {
            metrics.push(name);
          },
        },
      });
    });

    it('the victim still signs in from their own browser, and a fresh browser is refused', async () => {
      const victim = `victim${String(prefixes)}@example.com`;
      const shadow = `nobody${String(prefixes)}@example.com`;
      await h.user(victim);

      // The victim signed in once before, so V holds a device cookie known for the user.
      const v: Browser = newBrowser(VICTIM_IP);
      const first = await requestCode(flow, v, victim);
      if (first === null) throw new Error('no mail for the victim');
      const signedIn = await flow.signIn.verifyEmailCode(v.context(), first);
      if (!signedIn.ok) throw signedIn.error;
      v.apply(signedIn.value.setCookies);
      expect(v.cookies.has(flow.config.cookies.device)).toBe(true);

      // Then opens a challenge and keeps it through the attack.
      const kept = await requestCode(flow, v, victim);
      if (kept === null) throw new Error('no mail for the kept challenge');
      const keptAttempts = () =>
        h.sql(`select attempts from app.email_challenges where id = '${kept.challengeId}';`);

      // The victim's first send had no device cookie and counted against the ceiling; the
      // address with no account gets the same one send, so both ceilings start level.
      const level = await flow.signIn.startEmailSignIn(newBrowser('2001:db8:5a::1').context(), {
        email: shadow,
      });
      expect(level.ok).toBe(true);

      // The attacker's browser, and a mirror that asks for an address with no account from
      // its own prefixes, so every answer can be compared with what a stranger's address gets.
      const b: Browser = newBrowser();
      const mirror: Browser = newBrowser();
      const refusals: string[] = [];
      let accepted = 0;
      let verifyRefused = false;

      const send = async (ip: string, mirrorIp: string, to = victim, mirrorTo = shadow) => {
        const result = await flow.signIn.startEmailSignIn(b.context({ ip }), { email: to });
        const shadowed = await flow.signIn.startEmailSignIn(mirror.context({ ip: mirrorIp }), {
          email: mirrorTo,
        });
        expect(wire(result)).toBe(wire(shadowed));
        if (result.ok) {
          b.apply(result.value.setCookies);
          await result.value.send();
        } else {
          refusals.push(result.error.code);
        }
        if (shadowed.ok) {
          mirror.apply(shadowed.value.setCookies);
          await shadowed.value.send();
        }
        return result.ok;
      };

      for (let p = 0; p < prefixes; p += 1) {
        const hosts = p === 0 ? [1, 2] : [1];
        for (const host of hosts) {
          let rounds = 0;
          while (await send(attackerIp(p, host), shadowIp(p, host))) {
            accepted += 1;
            rounds += 1;
            expect(rounds).toBeLessThanOrEqual(3);
            // Wrong codes on its own newest challenge until code_verify on (address, B) refuses.
            const own = flow.mail.sent.filter((m) => m.to === victim).at(-1);
            if (own === undefined || verifyRefused) continue;
            const challenge = own.link.hash.slice(1, 27);
            for (let i = 0; i < 5 && !verifyRefused; i += 1) {
              const r = await flow.signIn.verifyEmailCode(b.context({ ip: attackerIp(p, host) }), {
                challenge,
                code: wrongCode(own.code),
              });
              if (!r.ok && r.error.code === 'AUTH_RATE_LIMITED') verifyRefused = true;
            }
          }
        }
        if (p === 0) {
          // The second host of prefix 0 was refused at once: the bucket is the /64.
          expect(refusals.at(-1)).toBe('AUTH_RATE_LIMITED');
          // The per IP limit for that /64: other addresses until it refuses too.
          let others = 0;
          while (
            await send(
              attackerIp(0, 3),
              shadowIp(0, 3),
              `other${String(others)}@example.com`,
              `othershadow${String(others)}@example.com`,
            )
          ) {
            others += 1;
            expect(others).toBeLessThanOrEqual(20);
          }
        }
      }
      expect(verifyRefused).toBe(true);
      expect(accepted).toBeGreaterThanOrEqual(prefixes * 2 - 1);

      // Codes for the victim's challenge from the attacker's browser: refused on the binding,
      // and the victim's attempt count does not move.
      for (let i = 0; i < 3; i += 1) {
        const r = await flow.signIn.verifyEmailCode(b.context({ ip: attackerIp(1) }), {
          challenge: kept.challenge,
          code: wrongCode(kept.code),
        });
        expect(!r.ok && r.error.code).toBe('AUTH_CHALLENGE_BINDING');
      }
      expect(await keptAttempts()).toBe('0');

      // Non vacuity: a fresh browser from a fresh prefix is refused, and only the ceiling can
      // refuse it there.
      const before = metrics.filter((m) => m === 'auth.email_ceiling_hit').length;
      expect(before).toBeGreaterThanOrEqual(1);
      const stranger = await flow.signIn.startEmailSignIn(newBrowser(FRESH_IP).context(), {
        email: victim,
      });
      expect(!stranger.ok && stranger.error.code).toBe('AUTH_RATE_LIMITED');

      // The victim: the challenge opened before the attack still verifies.
      const resumed = await flow.signIn.verifyEmailCode(v.context(), kept);
      if (!resumed.ok) throw resumed.error;
      v.apply(resumed.value.setCookies);

      // And a new sign in from V's own address and device cookie gets mail and a session.
      const again = await requestCode(flow, v, victim);
      if (again === null) throw new Error('the victim got no mail during the attack');
      const last = await flow.signIn.verifyEmailCode(v.context(), again);
      expect(last.ok).toBe(true);
    });
  });
});

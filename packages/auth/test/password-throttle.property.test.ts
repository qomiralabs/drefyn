import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createEmailSignIn, createPasswordSignIn, encodeSecret } from '../src/index.ts';
import { createTestAuthMailer } from '../src/testing.ts';
import { emailResponder, recordingLogger, fakeSessions } from './email-fixtures.ts';
import { scriptedStore } from './scripted-store.ts';
import {
  PASSWORD,
  config,
  countingLimiter,
  csrfFor,
  fakePasswordSessions,
  passwordResponder,
} from './password-sign-in-fixtures.ts';
import { smallHasher } from './password-fixtures.ts';
import { runs } from './support.ts';

const VICTIM = 'victim@example.com';
const VICTIM_IP = '192.0.2.10';
const hasher = smallHasher();
const stored = await hasher.hash(PASSWORD);

const attempt = fc.record({
  address: fc.constantFrom(VICTIM, 'other@example.com', 'third@example.com'),
  ip: fc.constantFrom(VICTIM_IP, '203.0.113.5', '2001:db8::1', '2001:db8::2'),
  right: fc.boolean(),
});

describe('password throttling never blocks email code sign in', () => {
  it('after any sequence of password attempts, the victim can still start an email code sign in', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(attempt, { minLength: 0, maxLength: 60 }), async (attempts) => {
        // One limiter for both flows, as in the app: the buckets must not overlap.
        const limiter = countingLimiter();
        const store = scriptedStore(passwordResponder({ known: true, phc: stored })).store;
        const { logger } = recordingLogger();
        const passwords = createPasswordSignIn(config, {
          store,
          logger,
          limiter,
          sessions: fakePasswordSessions(),
          hasher,
        });
        const pre = Buffer.alloc(32, 4);
        const cookies = new Map([[config.cookies.pre, encodeSecret(pre)]]);
        const csrf = csrfFor(config, pre);
        const limited: string[] = [];
        for (const a of attempts) {
          const result = await passwords.signInWithPassword(
            { ip: a.ip, userAgent: 'x', cookies },
            { email: a.address, password: a.right ? PASSWORD : 'not the password at all', csrf },
          );
          if (!result.ok && result.error.code === 'AUTH_RATE_LIMITED') limited.push(a.address);
        }
        // Non vacuous: past ten attempts the victim's password bucket is full.
        if (attempts.filter((a) => a.address === VICTIM).length > 10) {
          expect(limited).toContain(VICTIM);
        }
        const before = limiter.reserved.length;
        const email = createEmailSignIn(config, {
          store: scriptedStore(emailResponder()).store,
          logger,
          mailer: createTestAuthMailer().mailer,
          sessions: fakeSessions(),
          limiter,
        });
        const start = await email.startEmailSignIn(
          { ip: VICTIM_IP, userAgent: 'x', cookies: new Map() },
          { email: VICTIM },
        );
        expect(start.ok).toBe(true);
        expect(limiter.reserved.slice(before).some((b) => b.startsWith('password_'))).toBe(false);
      }),
      {
        ...runs,
        numRuns: 60,
        examples: [
          [Array.from({ length: 30 }, () => ({ address: VICTIM, ip: VICTIM_IP, right: true }))],
        ],
      },
    );
  });
});

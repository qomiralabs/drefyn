import { randomBytes } from 'node:crypto';
import fc from 'fast-check';
import { beforeAll, expect, it } from 'vitest';
import { countSeats, type RateLimiter, type SeatHolder } from '../../src/index.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';

const fresh = harness();
let h: Harness;

const unlimited: RateLimiter = { keyFor: () => Buffer.alloc(32), reserve: () => Promise.resolve() };

const browser = {
  ip: '203.0.113.9',
  userAgent: 'Property/1.0',
  cookies: new Map<string, string>(),
};

// Extra members, and invitations that are live or expired, for one organization.
const plan = fc.record({
  members: fc.integer({ min: 0, max: 4 }),
  invitations: fc.array(fc.boolean(), { maxLength: 6 }),
});

describeWithStack('the SQL seat count', () => {
  beforeAll(async () => {
    h = await fresh();
  });

  it('equals countSeats over the same memberships and invitations', async () => {
    await fc.assert(
      fc.asyncProperty(plan, async ({ members, invitations }) => {
        const owner = await h.user();
        const started = await h
          .sessions()
          .startSession(browser, { userId: owner, method: 'email' });
        const made = await h
          .organizations({ limiter: unlimited })
          .createOrganization(started.session, {
            name: 'Seat Co',
            slug: `s-${randomBytes(6).toString('hex')}`,
          });
        if (!made.ok) throw made.error;
        const org = made.value.organizationId;
        const holders: SeatHolder[] = [{ kind: 'member', userId: owner }];
        for (let i = 0; i < members; i += 1) {
          const user = await h.user();
          // Acceptance is proved in its own tests; the superuser seeds faster here.
          await h.sql(
            `insert into app.memberships (organization_id, user_id, role)
             values ('${org}', '${user}', 'member');`,
          );
          holders.push({ kind: 'member', userId: user });
        }
        for (const live of invitations) {
          const email = `i${randomBytes(5).toString('hex')}@example.com`;
          await h.sql(
            `insert into app.invitations (organization_id, email_normalized, role, secret_hash, invited_by, expires_at)
             values ('${org}', '${email}', 'member', decode(repeat('00', 32), 'hex'),
               (select id from app.memberships where organization_id = '${org}' and role = 'owner'),
               now() ${live ? '+' : '-'} interval '1 day');`,
          );
          if (live) holders.push({ kind: 'invitation', email });
        }
        const usage = await h.invitations().seatUsage(made.value);
        expect(usage.used).toBe(countSeats(holders));
      }),
      { seed: 134, numRuns: 15 },
    );
  });
});

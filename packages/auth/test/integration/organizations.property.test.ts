import { randomBytes } from 'node:crypto';
import { withOrganization, withUser } from '@drefyn/db';
import type { OrganizationId, UserId } from '@drefyn/tenancy';
import fc from 'fast-check';
import { beforeAll, expect, it } from 'vitest';
import type { CookieSpec, RateLimiter } from '../../src/index.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';

const fresh = harness();
let h: Harness;

// The daily cap is proved elsewhere; here one person may own several organizations.
const unlimited: RateLimiter = { keyFor: () => Buffer.alloc(32), reserve: () => Promise.resolve() };

const browser = {
  ip: '203.0.113.9',
  userAgent: 'Property/1.0',
  cookies: new Map<string, string>(),
};

interface Person {
  readonly user: UserId;
  readonly cookie: string;
  readonly session: Awaited<ReturnType<ReturnType<Harness['sessions']>['startSession']>>['session'];
}

const cookieOf = (cookies: readonly CookieSpec[]) =>
  cookies.find((c) => c.name === h.config.cookies.session && c.maxAgeSeconds > 0)?.value ?? '';

// People, organizations, and who else belongs to each one besides its owner.
const world = fc.integer({ min: 2, max: 4 }).chain((people) =>
  fc.record({
    people: fc.constant(people),
    orgs: fc.array(
      fc.record({
        owner: fc.nat({ max: people - 1 }),
        members: fc.uniqueArray(fc.nat({ max: people - 1 }), { maxLength: people }),
      }),
      { minLength: 1, maxLength: 4 },
    ),
  }),
);

const sorted = (values: readonly string[]) => [...values].sort();

describeWithStack('cross tenant reads under a user context', () => {
  beforeAll(async () => {
    h = await fresh();
  });

  it('each person reads exactly the organizations, slugs and memberships of their own', async () => {
    const sessions = h.sessions();
    const orgs = h.organizations({ limiter: unlimited });
    await fc.assert(
      fc.asyncProperty(world, async ({ people, orgs: plan }) => {
        const persons: Person[] = [];
        for (let i = 0; i < people; i += 1) {
          const user = await h.user();
          const started = await sessions.startSession(browser, { userId: user, method: 'email' });
          persons.push({ user, session: started.session, cookie: cookieOf(started.setCookies) });
        }
        const made: { id: OrganizationId; slug: string; members: Set<number> }[] = [];
        for (const [index, org] of plan.entries()) {
          const owner = persons[org.owner];
          if (owner === undefined) throw new Error('no owner');
          const slug = `p-${randomBytes(6).toString('hex')}`;
          const result = await orgs.createOrganization(owner.session, {
            name: `Org ${String(index)}`,
            slug,
          });
          if (!result.ok) throw result.error;
          const members = new Set([org.owner]);
          for (const m of org.members.filter((m) => m !== org.owner)) {
            const person = persons[m];
            if (person === undefined) throw new Error('no member');
            await withOrganization(h.db, { organizationId: result.value.organizationId }, (tx) =>
              tx
                .insertInto('memberships')
                .values({
                  organization_id: result.value.organizationId,
                  user_id: person.user,
                  role: 'member',
                })
                .execute(),
            );
            members.add(m);
          }
          made.push({ id: result.value.organizationId, slug, members });
        }

        for (const [index, person] of persons.entries()) {
          const mine = made.filter((o) => o.members.has(index));
          const seen = await withUser(h.db, { userId: person.user }, async (tx) => ({
            orgs: (await tx.selectFrom('organizations').select('organization_id').execute()).map(
              (r) => r.organization_id,
            ),
            slugs: (await tx.selectFrom('organization_slugs').select('slug').execute()).map(
              (r) => r.slug,
            ),
            memberships: await tx.selectFrom('memberships').select(['user_id']).execute(),
            // Asked by name: every slug of the run, including those of other organizations.
            bySlug: (
              await tx
                .selectFrom('organization_slugs')
                .select('slug')
                .where(
                  'slug',
                  'in',
                  made.map((o) => o.slug),
                )
                .execute()
            ).map((r) => r.slug),
          }));
          expect(sorted(seen.orgs)).toEqual(sorted(mine.map((o) => o.id)));
          expect(sorted(seen.slugs)).toEqual(sorted(mine.map((o) => o.slug)));
          expect(sorted(seen.bySlug)).toEqual(sorted(mine.map((o) => o.slug)));
          expect(seen.memberships.every((m) => m.user_id === person.user)).toBe(true);
          expect(seen.memberships).toHaveLength(mine.length);

          const listed = await orgs.listMyOrganizations(person.session);
          expect(sorted(listed.map((o) => o.organizationId))).toEqual(
            sorted(mine.map((o) => o.id)),
          );

          for (const org of made) {
            const access = await sessions.resolveAccess(person.cookie, org.slug);
            expect(access.kind).toBe(org.members.has(index) ? 'ok' : 'not_member');
            if (access.kind === 'ok') expect(access.access.organizationId).toBe(org.id);
          }
        }
      }),
      { seed: 131, numRuns: 12 },
    );
  });
});

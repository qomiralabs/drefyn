import { randomBytes } from 'node:crypto';
import { newId, withOrganization } from '@drefyn/db';
import { TIERS } from '@drefyn/entitlements';
import { toPublicId } from '@drefyn/tenancy';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CookieSpec, SessionInfo } from '../../src/index.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';

const fresh = harness();
let h: Harness;

const browser = () => ({
  ip: '203.0.113.9',
  userAgent: 'Integration/1.0',
  cookies: new Map<string, string>(),
});

const cookieOf = (cookies: readonly CookieSpec[]) => {
  const found = cookies.find((c) => c.name === h.config.cookies.session && c.maxAgeSeconds > 0);
  if (found === undefined) throw new Error('no session cookie');
  return found.value;
};

const slug = (prefix = 'org') => `${prefix}-${randomBytes(5).toString('hex')}`;

async function signIn() {
  const sessions = h.sessions();
  const user = await h.user();
  const started = await sessions.startSession(browser(), { userId: user, method: 'email' });
  return { sessions, user, session: started.session, cookie: cookieOf(started.setCookies) };
}

const count = (table: string, where: string) =>
  h.sql(`select count(*) from app.${table} where ${where};`);

describeWithStack('organizations against Postgres', () => {
  beforeAll(async () => {
    h = await fresh();
  });

  it('creates the organization, its slug and the owner membership together', async () => {
    const { session } = await signIn();
    const name = slug('Name');
    const result = await h.organizations().createOrganization(session, { name });
    if (!result.ok) throw result.error;
    const org = result.value.access.organizationId;
    expect(result.value.slug).toBe(name.toLowerCase());
    expect(
      await h.sql(
        `select name || '|' || plan_tier from app.organizations where organization_id = '${org}';`,
      ),
    ).toBe(`${name}|self_hosted`);
    expect(
      await h.sql(
        `select organization_id from app.organization_slugs where slug = '${result.value.slug}';`,
      ),
    ).toBe(org);
    expect(
      await h.sql(
        `select role from app.memberships where organization_id = '${org}' and user_id = '${session.userId}';`,
      ),
    ).toBe('owner');
  });

  it('writes nothing when the third insert, the membership, fails', async () => {
    // A person whose row is gone: the organization and slug inserts pass, the membership's
    // foreign key does not.
    const { session } = await signIn();
    const ghost: SessionInfo = { ...session, userId: newId('usr') };
    const name = slug('Ghost');
    const result = await h.organizations().createOrganization(ghost, { name });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AUTH_UNAVAILABLE');
    expect(await count('organizations', `name = '${name}'`)).toBe('0');
    expect(await count('organization_slugs', `slug = '${name.toLowerCase()}'`)).toBe('0');
    expect(await count('memberships', `user_id = '${ghost.userId}'`)).toBe('0');
    expect(h.logs.at(-1)).toMatchObject({
      level: 'warn',
      event: 'auth.organization_create_failed',
    });
  });

  it('refuses a fourth organization in a day from one person with AUTH_RATE_LIMITED', async () => {
    const { session } = await signIn();
    const orgs = h.organizations();
    for (let i = 0; i < 3; i += 1) {
      const made = await orgs.createOrganization(session, { name: slug('Team') });
      expect(made.ok, `organization ${String(i + 1)}`).toBe(true);
    }
    const fourth = await orgs.createOrganization(session, { name: slug('Team') });
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) {
      expect(fourth.error.code).toBe('AUTH_RATE_LIMITED');
      expect(fourth.error.retryAfterSeconds).toBeGreaterThan(0);
    }
    expect(await count('memberships', `user_id = '${session.userId}'`)).toBe('3');
    // Another person is not held to the first one's count.
    const other = await signIn();
    expect((await orgs.createOrganization(other.session, { name: slug('Other') })).ok).toBe(true);
  });

  it('gives a second organization of the same name a suffix', async () => {
    const first = await signIn();
    const second = await signIn();
    const name = slug('Twin');
    const orgs = h.organizations();
    const one = await orgs.createOrganization(first.session, { name });
    const two = await orgs.createOrganization(second.session, { name });
    if (!one.ok) throw one.error;
    if (!two.ok) throw two.error;
    expect(one.value.slug).toBe(name.toLowerCase());
    expect(two.value.slug).toMatch(new RegExp(`^${one.value.slug}-[a-z0-9]{4}$`));
    expect(await count('organizations', `name = '${name}'`)).toBe('2');
  });

  it('lets everyone through when many people create the same name at once', async () => {
    const people = await Promise.all(Array.from({ length: 12 }, () => signIn()));
    const name = slug('Crowd');
    const orgs = h.organizations();
    const made = await Promise.all(
      people.map((person) => orgs.createOrganization(person.session, { name })),
    );
    const slugs = made.map((result) => {
      if (!result.ok) throw result.error;
      return result.value.slug;
    });
    expect(new Set(slugs).size).toBe(people.length);
    expect(slugs).toContain(name.toLowerCase());
    expect(await count('organizations', `name = '${name}'`)).toBe(String(people.length));
    for (const [index, person] of people.entries()) {
      const resolved = await person.sessions.resolveAccess(person.cookie, slugs[index] ?? '');
      expect(resolved.kind).toBe('ok');
    }
  });

  it.each([
    ['settings', /^settings-[a-z0-9]{4}$/],
    ['Sign In', /^sign-in-[a-z0-9]{4}$/],
    ['\u5317\u4eac', /^org-[a-z0-9]{4}$/],
  ])('makes a valid slug for the name %j', async (name, shape) => {
    const { session } = await signIn();
    const result = await h.organizations().createOrganization(session, { name });
    if (!result.ok) throw result.error;
    expect(result.value.slug).toMatch(shape);
  });

  // The database holds the install tier, so a build that passes the wrong one fails closed.
  it('refuses free on a self host database, keeps nothing and logs ids only', async () => {
    const { session } = await signIn();
    const name = slug('Hosted');
    const before = h.logs.length;
    const result = await h.organizations({ initialTier: 'free' }).createOrganization(session, {
      name,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('AUTH_UNAVAILABLE');
      expect(result.error.cause).toMatchObject({ code: 'DB_RLS_VIOLATION' });
    }
    expect(await count('organizations', `name = '${name}'`)).toBe('0');
    expect(await count('organization_slugs', `slug = '${name.toLowerCase()}'`)).toBe('0');
    expect(await count('memberships', `user_id = '${session.userId}'`)).toBe('0');
    const lines = h.logs.slice(before);
    expect(lines).toEqual([
      {
        level: 'warn',
        event: 'auth.organization_create_failed',
        fields: {
          organizationId: expect.stringMatching(/^org_/) as unknown,
          userId: toPublicId('usr', session.userId),
        },
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain(name);
    expect(JSON.stringify(lines)).not.toContain(name.toLowerCase());
  });

  it('lists only the organizations the person belongs to', async () => {
    const a = await signIn();
    const b = await signIn();
    const orgs = h.organizations();
    const name = slug('Mine');
    await orgs.createOrganization(a.session, { name });
    await orgs.createOrganization(b.session, { name: slug('Theirs') });
    const listed = await orgs.listMyOrganizations(a.session);
    expect(listed.map((o) => o.slug)).toEqual([name.toLowerCase()]);
    expect(listed[0]).toMatchObject({
      name,
      role: 'owner',
      tier: 'self_hosted',
      readOnlySince: null,
    });
  });

  it('resolves access for a member and nothing for anyone else', async () => {
    const owner = await signIn();
    const stranger = await signIn();
    const made = await h.organizations().createOrganization(owner.session, { name: 'Guarded' });
    if (!made.ok) throw made.error;
    const s = made.value.slug;
    const ok = await owner.sessions.resolveAccess(owner.cookie, s);
    expect(ok).toMatchObject({
      kind: 'ok',
      touchDue: false,
      access: {
        organizationId: made.value.access.organizationId,
        role: 'owner',
        tier: 'self_hosted',
      },
    });
    expect(await stranger.sessions.resolveAccess(stranger.cookie, s)).toEqual({
      kind: 'not_member',
    });
    expect(await stranger.sessions.resolveAccess(stranger.cookie, slug('none'))).toEqual({
      kind: 'not_member',
    });
    // A different last symbol: one that was already "a" left the cookie as it was.
    const forged = `${owner.cookie.slice(0, -1)}${owner.cookie.endsWith('a') ? 'b' : 'a'}`;
    expect(await stranger.sessions.resolveAccess(forged, s)).toEqual({
      kind: 'signed_out',
    });
    expect(await stranger.sessions.resolveAccess(undefined, s)).toEqual({ kind: 'signed_out' });
  });

  it('logs created organizations by id, with no name or slug', async () => {
    const { session } = await signIn();
    const name = slug('Secret Name');
    const before = h.logs.length;
    const made = await h.organizations().createOrganization(session, { name });
    if (!made.ok) throw made.error;
    const lines = h.logs.slice(before);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      event: 'auth.organization_created',
      fields: { organizationId: toPublicId('org', made.value.access.organizationId) },
    });
    expect(JSON.stringify(lines)).not.toContain(name);
    expect(JSON.stringify(lines)).not.toContain(made.value.slug);
  });

  describe('plan_tier', () => {
    const insert = (tier: string) =>
      withOrganization(h.db, { organizationId: newId('org') }, (tx) =>
        sql`insert into app.organizations (organization_id, name, plan_tier)
            values (app.current_org(), 'Tier', ${tier})`.execute(tx),
      );

    it('accepts the install tier, self_hosted', async () => {
      await expect(insert('self_hosted')).resolves.toBeDefined();
    });

    it.each(TIERS.filter((t) => t !== 'self_hosted').map((t) => [t]))(
      'refuses %s with DB_RLS_VIOLATION',
      async (tier) => {
        await expect(insert(tier)).rejects.toMatchObject({ code: 'DB_RLS_VIOLATION' });
      },
    );

    const unknown = [
      '',
      'FREE',
      'Free',
      ' free',
      'free ',
      'pro',
      'self-hosted',
      'hosted',
      'enterprise2',
      'null',
    ];

    it.each(unknown)('refuses %j through drefyn_app with DB_RLS_VIOLATION', async (tier) => {
      await expect(insert(tier)).rejects.toMatchObject({ code: 'DB_RLS_VIOLATION' });
    });

    // The policy runs before the check constraint, so the constraint is proved without RLS.
    it.each(unknown)('refuses %j with the check constraint as well', async (tier) => {
      const id = newId('org');
      await expect(
        h.sql(
          `insert into app.organizations (organization_id, name, plan_tier) values ('${id}', 'Tier', '${tier}');`,
        ),
      ).rejects.toThrow(/organizations_plan_tier_check/);
    });
  });

  // drefyn-cloud replaces the function from its own migration; the same code then writes free.
  describe('on a hosted database, where the install tier is free', () => {
    const installTier = (tier: string) =>
      h.sql(`create or replace function app.install_tier() returns text
               language sql stable parallel safe
               as $$ select '${tier}'::text $$;`);

    beforeAll(async () => {
      await installTier('free');
    });

    afterAll(async () => {
      await installTier('self_hosted');
    });

    it('writes free when built for hosted signup', async () => {
      const { session } = await signIn();
      const result = await h
        .organizations({ initialTier: 'free' })
        .createOrganization(session, { name: 'Hosted' });
      if (!result.ok) throw result.error;
      expect(
        await h.sql(
          `select plan_tier from app.organizations where organization_id = '${result.value.access.organizationId}';`,
        ),
      ).toBe('free');
    });

    it('refuses self_hosted there', async () => {
      const { session } = await signIn();
      const result = await h
        .organizations({ initialTier: 'self_hosted' })
        .createOrganization(session, { name: 'Self' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.cause).toMatchObject({ code: 'DB_RLS_VIOLATION' });
    });
  });
});

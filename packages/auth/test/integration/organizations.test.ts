import { randomBytes } from 'node:crypto';
import { newId, withOrganization } from '@drefyn/db';
import { TIERS } from '@drefyn/entitlements';
import { toPublicId } from '@drefyn/tenancy';
import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
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
    const s = slug();
    const result = await h.organizations().createOrganization(session, { name, slug: s });
    if (!result.ok) throw result.error;
    const org = result.value.organizationId;
    expect(
      await h.sql(
        `select name || '|' || plan_tier from app.organizations where organization_id = '${org}';`,
      ),
    ).toBe(`${name}|self_hosted`);
    expect(
      await h.sql(`select organization_id from app.organization_slugs where slug = '${s}';`),
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
    const s = slug();
    const result = await h.organizations().createOrganization(ghost, { name, slug: s });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AUTH_UNAVAILABLE');
    expect(await count('organizations', `name = '${name}'`)).toBe('0');
    expect(await count('organization_slugs', `slug = '${s}'`)).toBe('0');
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
      const made = await orgs.createOrganization(session, {
        name: `Team ${String(i)}`,
        slug: slug(),
      });
      expect(made.ok, `organization ${String(i + 1)}`).toBe(true);
    }
    const fourth = await orgs.createOrganization(session, { name: 'Team 4', slug: slug() });
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) {
      expect(fourth.error.code).toBe('AUTH_RATE_LIMITED');
      expect(fourth.error.retryAfterSeconds).toBeGreaterThan(0);
    }
    expect(await count('memberships', `user_id = '${session.userId}'`)).toBe('3');
    // Another person is not held to the first one's count.
    const other = await signIn();
    expect((await orgs.createOrganization(other.session, { name: 'Other', slug: slug() })).ok).toBe(
      true,
    );
  });

  it('answers AUTH_SLUG_TAKEN for a slug another organization holds and keeps nothing', async () => {
    const first = await signIn();
    const second = await signIn();
    const s = slug();
    const orgs = h.organizations();
    expect((await orgs.createOrganization(first.session, { name: 'First', slug: s })).ok).toBe(
      true,
    );
    const taken = await orgs.createOrganization(second.session, { name: 'Second Co', slug: s });
    expect(taken.ok).toBe(false);
    if (!taken.ok) expect(taken.error.code).toBe('AUTH_SLUG_TAKEN');
    expect(await count('organizations', `name = 'Second Co'`)).toBe('0');
    expect(await count('memberships', `user_id = '${second.session.userId}'`)).toBe('0');
  });

  it.each(['settings', 'sign-in', 'Acme', 'acme.com'])(
    'refuses the slug %j with AUTH_SLUG_INVALID',
    async (value) => {
      const { session } = await signIn();
      const result = await h
        .organizations()
        .createOrganization(session, { name: 'X', slug: value });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('AUTH_SLUG_INVALID');
    },
  );

  it('writes free when built for hosted signup', async () => {
    const { session } = await signIn();
    const result = await h
      .organizations({ initialTier: 'free' })
      .createOrganization(session, { name: 'Hosted', slug: slug() });
    if (!result.ok) throw result.error;
    expect(
      await h.sql(
        `select plan_tier from app.organizations where organization_id = '${result.value.organizationId}';`,
      ),
    ).toBe('free');
  });

  it('lists only the organizations the person belongs to', async () => {
    const a = await signIn();
    const b = await signIn();
    const orgs = h.organizations();
    const mine = slug();
    const theirs = slug();
    await orgs.createOrganization(a.session, { name: 'Mine', slug: mine });
    await orgs.createOrganization(b.session, { name: 'Theirs', slug: theirs });
    const listed = await orgs.listMyOrganizations(a.session);
    expect(listed.map((o) => o.slug)).toEqual([mine]);
    expect(listed[0]).toMatchObject({
      name: 'Mine',
      role: 'owner',
      tier: 'self_hosted',
      readOnlySince: null,
    });
  });

  it('resolves access for a member and nothing for anyone else', async () => {
    const owner = await signIn();
    const stranger = await signIn();
    const s = slug();
    const made = await h
      .organizations()
      .createOrganization(owner.session, { name: 'Guarded', slug: s });
    if (!made.ok) throw made.error;
    const ok = await owner.sessions.resolveAccess(owner.cookie, s);
    expect(ok).toMatchObject({
      kind: 'ok',
      touchDue: false,
      access: { organizationId: made.value.organizationId, role: 'owner', tier: 'self_hosted' },
    });
    expect(await stranger.sessions.resolveAccess(stranger.cookie, s)).toEqual({
      kind: 'not_member',
    });
    expect(await stranger.sessions.resolveAccess(stranger.cookie, slug('none'))).toEqual({
      kind: 'not_member',
    });
    expect(await stranger.sessions.resolveAccess(`${owner.cookie.slice(0, -1)}a`, s)).toEqual({
      kind: 'signed_out',
    });
    expect(await stranger.sessions.resolveAccess(undefined, s)).toEqual({ kind: 'signed_out' });
  });

  it('logs created organizations by id, with no name or slug', async () => {
    const { session } = await signIn();
    const name = slug('Secret Name');
    const s = slug();
    const before = h.logs.length;
    const made = await h.organizations().createOrganization(session, { name, slug: s });
    if (!made.ok) throw made.error;
    const lines = h.logs.slice(before);
    expect(lines).toEqual([
      expect.objectContaining({
        level: 'info',
        event: 'auth.organization_created',
        fields: expect.objectContaining({
          organizationId: toPublicId('org', made.value.organizationId),
        }),
      }),
    ]);
    expect(JSON.stringify(lines)).not.toContain(name);
    expect(JSON.stringify(lines)).not.toContain(s);
  });

  describe('plan_tier', () => {
    const insert = (tier: string) =>
      withOrganization(h.db, { organizationId: newId('org') }, (tx) =>
        sql`insert into app.organizations (organization_id, name, plan_tier)
            values (app.current_org(), 'Tier', ${tier})`.execute(tx),
      );

    it.each(TIERS.map((t) => [t]))('accepts %s', async (tier) => {
      await expect(insert(tier)).resolves.toBeDefined();
    });

    it.each([
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
    ])('refuses %j with a check violation', async (tier) => {
      await expect(insert(tier)).rejects.toMatchObject({ code: '23514' });
    });
  });
});

import { DbError, type AuthDatabase, type Database } from '@drefyn/db';
import { PRODUCTS } from '@drefyn/entitlements';
import { idOf, toPublicId, type OrganizationId } from '@drefyn/tenancy';
import { describe, expect, it } from 'vitest';
import {
  AuthError,
  createOrganizations,
  permissionsFor,
  type AuthLogger,
  type OrganizationsDeps,
  type RateLimiter,
} from '../src/index.ts';
import { scriptedStore, type Responder, type Statement } from './scripted-store.ts';
import {
  AUTHENTICATED_AT,
  SESSION,
  USER,
  config,
  noopLimiter,
  sessionInfo,
} from './session-fixtures.ts';

const ORG: OrganizationId = idOf('org', '01890a5d-ac96-774b-bcce-b302099a8070');
const MEMBERSHIP = '01890a5d-ac96-774b-bcce-b302099a8071';
const NAME = 'Acme Widgets';
const SLUG = 'acme-widgets';

const isOrgInsert = (s: Statement) => s.sql.startsWith('insert into "organizations"');
const isSlugInsert = (s: Statement) => s.sql.startsWith('insert into "organization_slugs"');
const isMemberInsert = (s: Statement) => s.sql.startsWith('insert into "memberships"');

// The three inserts answer as the database would when nothing is in the way.
const happy: Responder = (s) => {
  if (isOrgInsert(s)) return [{ organization_id: ORG }];
  if (isSlugInsert(s)) return [{ slug: SLUG }];
  if (isMemberInsert(s)) return [{ id: MEMBERSHIP }];
  return [];
};

const slugOf = (s: Statement): unknown => s.parameters[0];
const triedSlugs = (scripted: { statements(): readonly Statement[] }) =>
  scripted.statements().filter(isSlugInsert).map(slugOf);

// Answers as the database does when these slugs already belong to someone: no row back.
const heldFor =
  (held: readonly string[]): Responder =>
  (s) =>
    isSlugInsert(s) && held.includes(String(slugOf(s))) ? [] : happy(s);

function loggers() {
  const lines: {
    level: 'info' | 'warn';
    event: string;
    fields: Readonly<Record<string, unknown>>;
  }[] = [];
  const logger: AuthLogger = {
    info(event, fields) {
      lines.push({ level: 'info', event, fields });
    },
    warn(event, fields) {
      lines.push({ level: 'warn', event, fields });
    },
  };
  return { logger, lines };
}

function setup(respond: Responder = happy, extra: Partial<OrganizationsDeps> = {}) {
  const scripted = scriptedStore(respond);
  const { logger, lines } = loggers();
  const limiter = noopLimiter();
  const orgs = createOrganizations(config, {
    db: {} as Database,
    authDb: {} as AuthDatabase,
    logger,
    limiter,
    store: scripted.store,
    initialTier: 'self_hosted',
    newOrganizationId: () => ORG,
    ...extra,
  });
  return { orgs, scripted, lines, limiter };
}

const failed = (result: { ok: true; value: unknown } | { ok: false; error: AuthError }) => {
  if (result.ok) throw new Error('expected a failure');
  return result.error;
};

describe('createOrganization', () => {
  it('writes the organization, its slug and the owner membership in one organization transaction', async () => {
    const { orgs, scripted, limiter } = setup();
    const result = await orgs.createOrganization(sessionInfo(), { name: NAME });
    expect(result.ok).toBe(true);
    expect(limiter.calls).toEqual([['org_create', [USER]]]);
    // The first owner must be the person acting, which the database checks.
    expect(scripted.events[0]).toEqual({
      kind: 'begin',
      scope: 'organization',
      organizationId: ORG,
      actorUserId: USER,
    });
    const statements = scripted.statements();
    expect(statements.map((s) => [isOrgInsert(s), isSlugInsert(s), isMemberInsert(s)])).toEqual([
      [true, false, false],
      [false, true, false],
      [false, false, true],
    ]);
    expect(scripted.events.at(-1)).toEqual({ kind: 'commit' });
    expect(statements[0]?.parameters).toEqual(expect.arrayContaining([ORG, NAME, 'self_hosted']));
    expect(statements[1]?.sql).toMatch(/on conflict \("slug"\) do nothing/);
    expect(statements[2]?.parameters).toEqual(expect.arrayContaining([ORG, USER, 'owner']));
  });

  it('returns the owner access context with every permission', async () => {
    const { orgs } = setup();
    const result = await orgs.createOrganization(sessionInfo(), { name: NAME });
    if (!result.ok) throw result.error;
    expect(result.value.access).toMatchObject({
      organizationId: ORG,
      userId: USER,
      sessionId: SESSION,
      role: 'owner',
      tier: 'self_hosted',
      authenticatedAt: AUTHENTICATED_AT,
    });
    expect(result.value.access.permissions).toEqual(permissionsFor('owner', new Set(PRODUCTS)));
    expect(Object.isFrozen(result.value.access)).toBe(true);
  });

  it('writes free when the hosted signup builds it', async () => {
    const { orgs, scripted } = setup(happy, { initialTier: 'free' });
    const result = await orgs.createOrganization(sessionInfo(), { name: NAME });
    expect(result.ok && result.value.access.tier).toBe('free');
    expect(scripted.statements()[0]?.parameters).toContain('free');
  });

  it('refuses any other starting tier when it is built', () => {
    for (const tier of ['enterprise', 'starter', '', 'FREE']) {
      expect(() => setup(happy, { initialTier: tier as OrganizationsDeps['initialTier'] })).toThrow(
        AuthError,
      );
    }
  });

  it('stores the normalised name', async () => {
    const { orgs, scripted } = setup();
    await orgs.createOrganization(sessionInfo(), { name: '  Ａｃｍｅ  ' });
    expect(scripted.statements()[0]?.parameters).toContain('Acme');
  });

  it.each([
    ['a domain like name', { name: 'acme.com' }, 'AUTH_INPUT_INVALID'],
    ['a scheme in the name', { name: 'see https://x' }, 'AUTH_INPUT_INVALID'],
  ])('refuses %s before counting or opening anything', async (_label, input, code) => {
    const { orgs, scripted, limiter } = setup();
    const error = failed(await orgs.createOrganization(sessionInfo(), input));
    expect(error.code).toBe(code);
    expect(limiter.calls).toEqual([]);
    expect(scripted.events).toEqual([]);
  });

  it('refuses a non string input without throwing', async () => {
    const { orgs } = setup();
    const input = { name: 7 } as unknown as { name: string };
    expect(failed(await orgs.createOrganization(sessionInfo(), input)).code).toBe(
      'AUTH_INPUT_INVALID',
    );
  });

  it('answers AUTH_RATE_LIMITED from the limiter and opens no transaction', async () => {
    const limiter: RateLimiter = {
      keyFor: () => Buffer.alloc(32),
      reserve: () =>
        Promise.reject(new AuthError('AUTH_RATE_LIMITED', { retryAfterSeconds: 3600 })),
    };
    const { orgs, scripted } = setup(happy, { limiter });
    const error = failed(await orgs.createOrganization(sessionInfo(), { name: NAME }));
    expect(error.code).toBe('AUTH_RATE_LIMITED');
    expect(error.retryAfterSeconds).toBe(3600);
    expect(scripted.events).toEqual([]);
  });

  it('takes the slug from the name and returns it', async () => {
    const { orgs, scripted } = setup();
    const result = await orgs.createOrganization(sessionInfo(), { name: 'Acme Inc' });
    if (!result.ok) throw result.error;
    expect(result.value.slug).toBe('acme-inc');
    expect(triedSlugs(scripted)).toEqual(['acme-inc']);
  });

  it('never takes a slug from the caller', async () => {
    const { orgs, scripted } = setup();
    const input = { name: 'Acme Inc', slug: 'chosen-by-client' } as { name: string };
    const result = await orgs.createOrganization(sessionInfo(), input);
    expect(result.ok && result.value.slug).toBe('acme-inc');
    expect(triedSlugs(scripted)).toEqual(['acme-inc']);
  });

  it.each([
    ['a reserved word', 'Settings', 'settings-b2c3'],
    ['an app route', 'Sign In', 'sign-in-b2c3'],
    ['no Latin letters', '\u5317\u4eac', 'org-b2c3'],
  ])('adds a suffix straight away for %s', async (_label, name, slug) => {
    const { orgs, scripted } = setup(happy, { newSlugSuffix: () => 'b2c3' });
    const result = await orgs.createOrganization(sessionInfo(), { name });
    expect(result.ok && result.value.slug).toBe(slug);
    expect(triedSlugs(scripted)).toEqual([slug]);
  });

  it('tries again with a suffix when the slug is held, from a clean transaction', async () => {
    const { orgs, scripted, limiter } = setup(heldFor(['acme-widgets']), {
      newSlugSuffix: () => 'b2c3',
    });
    const result = await orgs.createOrganization(sessionInfo(), { name: NAME });
    if (!result.ok) throw result.error;
    expect(result.value.slug).toBe('acme-widgets-b2c3');
    expect(triedSlugs(scripted)).toEqual(['acme-widgets', 'acme-widgets-b2c3']);
    const ends = scripted.events.filter((e) => e.kind !== 'statement').map((e) => e.kind);
    expect(ends).toEqual(['begin', 'rollback', 'begin', 'commit']);
    expect(scripted.statements().filter(isMemberInsert)).toHaveLength(1);
    expect(limiter.calls).toEqual([['org_create', [USER]]]);
  });

  it('takes a new suffix on each try and keeps one organization id', async () => {
    const suffixes = ['b2c3', 'd4f5', 'g6h7'];
    const { orgs, scripted } = setup(heldFor(['acme-widgets', 'acme-widgets-b2c3']), {
      newSlugSuffix: () => suffixes.shift() ?? 'none',
    });
    const result = await orgs.createOrganization(sessionInfo(), { name: NAME });
    expect(result.ok && result.value.slug).toBe('acme-widgets-d4f5');
    const ids = new Set(
      scripted
        .statements()
        .filter(isOrgInsert)
        .map((s) => s.parameters[0]),
    );
    expect(ids).toEqual(new Set([ORG]));
  });

  it('gives up after five tries with the same failure as any other, naming no slug', async () => {
    const { orgs, scripted, lines } = setup((s) => (isSlugInsert(s) ? [] : happy(s)), {
      newSlugSuffix: () => 'b2c3',
    });
    const error = failed(await orgs.createOrganization(sessionInfo(), { name: NAME }));
    expect(error.code).toBe('AUTH_UNAVAILABLE');
    expect(triedSlugs(scripted)).toHaveLength(5);
    expect(scripted.statements().some(isMemberInsert)).toBe(false);
    expect(lines).toEqual([
      {
        level: 'warn',
        event: 'auth.organization_create_failed',
        fields: { organizationId: toPublicId('org', ORG), userId: toPublicId('usr', USER) },
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain(SLUG);
  });

  it('retries only a held slug, never another failure', async () => {
    const { orgs, scripted } = setup((s) => {
      if (isSlugInsert(s)) throw Object.assign(new Error('down'), { code: '57P01' });
      return happy(s);
    });
    expect(failed(await orgs.createOrganization(sessionInfo(), { name: NAME })).code).toBe(
      'AUTH_UNAVAILABLE',
    );
    expect(triedSlugs(scripted)).toHaveLength(1);
  });

  it('makes suffixes of four unambiguous characters by default', async () => {
    const { orgs, scripted } = setup(heldFor(['acme-widgets']));
    await orgs.createOrganization(sessionInfo(), { name: NAME });
    expect(triedSlugs(scripted)[1]).toMatch(/^acme-widgets-[b-df-hj-km-np-tv-xz2-9]{4}$/);
  });

  it('rolls back and answers AUTH_UNAVAILABLE when the membership insert fails', async () => {
    const { orgs, scripted, lines } = setup((s) => {
      if (isMemberInsert(s)) throw Object.assign(new Error('fk'), { code: '23503' });
      return happy(s);
    });
    const error = failed(await orgs.createOrganization(sessionInfo(), { name: NAME }));
    expect(error.code).toBe('AUTH_UNAVAILABLE');
    expect(scripted.events.at(-1)).toEqual({ kind: 'rollback' });
    expect(lines).toEqual([
      {
        level: 'warn',
        event: 'auth.organization_create_failed',
        fields: { organizationId: toPublicId('org', ORG), userId: toPublicId('usr', USER) },
      },
    ]);
  });

  // The database refuses a tier other than the install's, or an owner it did not expect.
  it.each([
    ['organization', isOrgInsert],
    ['membership', isMemberInsert],
  ])(
    'answers AUTH_UNAVAILABLE over DB_RLS_VIOLATION when the %s insert is refused',
    async (_label, refused) => {
      const { orgs, scripted, lines } = setup((s) => {
        if (refused(s)) {
          throw new DbError('DB_RLS_VIOLATION', 'a row level security policy refused the write');
        }
        return happy(s);
      });
      const error = failed(await orgs.createOrganization(sessionInfo(), { name: NAME }));
      expect(error.code).toBe('AUTH_UNAVAILABLE');
      expect(error.cause).toMatchObject({ code: 'DB_RLS_VIOLATION' });
      expect(scripted.events.at(-1)).toEqual({ kind: 'rollback' });
      expect(lines).toEqual([
        {
          level: 'warn',
          event: 'auth.organization_create_failed',
          fields: { organizationId: toPublicId('org', ORG), userId: toPublicId('usr', USER) },
        },
      ]);
      expect(JSON.stringify(lines)).not.toContain(NAME);
      expect(JSON.stringify(lines)).not.toContain(SLUG);
    },
  );

  it('logs the created organization by id, never by name or slug', async () => {
    const { orgs, lines } = setup();
    await orgs.createOrganization(sessionInfo(), { name: NAME });
    expect(lines).toEqual([
      {
        level: 'info',
        event: 'auth.organization_created',
        fields: {
          organizationId: toPublicId('org', ORG),
          userId: toPublicId('usr', USER),
          membershipId: toPublicId('mem', idOf('mem', MEMBERSHIP)),
        },
      },
    ]);
    const text = JSON.stringify(lines);
    expect(text).not.toContain(NAME);
    expect(text).not.toContain(SLUG);
    expect(text).not.toContain('person@example.com');
  });

  it('still answers when the logger throws or has no info level', async () => {
    const throwing: AuthLogger = {
      info: () => {
        throw new Error('sink down');
      },
      warn: () => {
        throw new Error('sink down');
      },
    };
    const first = setup(happy, { logger: throwing });
    expect((await first.orgs.createOrganization(sessionInfo(), { name: NAME })).ok).toBe(true);
    const warnOnly: AuthLogger = { warn: () => undefined };
    const second = setup(happy, { logger: warnOnly });
    expect((await second.orgs.createOrganization(sessionInfo(), { name: NAME })).ok).toBe(true);
  });

  it('makes a fresh organization id per call by default', async () => {
    const ids: string[] = [];
    const scripted = scriptedStore((s) => {
      if (isOrgInsert(s)) ids.push(String(s.parameters[0]));
      return isSlugInsert(s) ? [{ slug: SLUG }] : isMemberInsert(s) ? [{ id: MEMBERSHIP }] : [];
    });
    const orgs = createOrganizations(config, {
      db: {} as Database,
      authDb: {} as AuthDatabase,
      logger: { warn: () => undefined },
      limiter: noopLimiter(),
      store: scripted.store,
      initialTier: 'self_hosted',
    });
    await orgs.createOrganization(sessionInfo(), { name: NAME });
    await orgs.createOrganization(sessionInfo(), { name: NAME });
    expect(new Set(ids).size).toBe(2);
  });
});

describe('listMyOrganizations', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    organization_id: ORG,
    name: NAME,
    slug: SLUG,
    role: 'owner',
    plan_tier: 'free',
    read_only_since: null,
    ...over,
  });

  it('reads under the person alone, through their own memberships', async () => {
    const { orgs, scripted } = setup(() => [row()]);
    const list = await orgs.listMyOrganizations(sessionInfo());
    expect(scripted.events[0]).toEqual({ kind: 'begin', scope: 'user', userId: USER });
    const statements = scripted.statements();
    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toMatch(/from "memberships"/);
    expect(statements[0]?.sql).toContain('app.current_user_id()');
    expect(scripted.writes()).toEqual([]);
    expect(list).toEqual([
      {
        organizationId: ORG,
        name: NAME,
        slug: SLUG,
        role: 'owner',
        tier: 'free',
        readOnlySince: null,
      },
    ]);
    expect(Object.isFrozen(list)).toBe(true);
  });

  it('carries read only state through', async () => {
    const since = new Date('2026-10-01T00:00:00.000Z');
    const { orgs } = setup(() => [row({ read_only_since: since, role: 'member' })]);
    const [first] = await orgs.listMyOrganizations(sessionInfo());
    expect(first).toMatchObject({ role: 'member', readOnlySince: since });
  });

  it('answers AUTH_UNAVAILABLE when the database fails or a stored value is unknown', async () => {
    const down = setup(() => {
      throw new Error('down');
    });
    await expect(down.orgs.listMyOrganizations(sessionInfo())).rejects.toMatchObject({
      code: 'AUTH_UNAVAILABLE',
    });
    for (const bad of [{ plan_tier: 'platinum' }, { role: 'root' }]) {
      const odd = setup(() => [row(bad)]);
      await expect(odd.orgs.listMyOrganizations(sessionInfo())).rejects.toMatchObject({
        code: 'AUTH_UNAVAILABLE',
      });
    }
  });
});

describe('createOrganizationFor', () => {
  it('takes the same path as createOrganization, with the person as actor and owner', async () => {
    const viaSession = setup();
    await viaSession.orgs.createOrganization(sessionInfo(), { name: NAME });
    const forUser = setup();
    const result = await forUser.orgs.createOrganizationFor(USER, { name: NAME });
    expect(result).toEqual({ ok: true, value: { organizationId: ORG, slug: SLUG } });
    expect(forUser.limiter.calls).toEqual([['org_create', [USER]]]);
    expect(forUser.scripted.events).toEqual(viaSession.scripted.events);
  });

  it('picks the slug the same way, suffix included', async () => {
    const taken = setup(heldFor(['acme-widgets']), { newSlugSuffix: () => 'b2c3' });
    const result = await taken.orgs.createOrganizationFor(USER, { name: NAME });
    expect(result).toEqual({
      ok: true,
      value: { organizationId: ORG, slug: 'acme-widgets-b2c3' },
    });
  });
});

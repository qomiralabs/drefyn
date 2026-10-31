import { PRODUCTS } from '@drefyn/entitlements';
import { idOf } from '@drefyn/tenancy';
import { describe, expect, it } from 'vitest';
import { permissionsFor } from '../src/index.ts';
import type { Responder, Statement } from './scripted-store.ts';
import {
  AUTHENTICATED_AT,
  OTHER_SESSION,
  SESSION,
  USER,
  isProof,
  sessionResponder,
  sessionRow,
  setup,
  tokenFor,
} from './session-fixtures.ts';

const ORG = idOf('org', '01890a5d-ac96-774b-bcce-b302099a8070');
const SLUG = 'acme';

const isMembershipRead = (s: Statement) =>
  /^select\b/i.test(s.sql) && s.sql.includes('"organization_slugs"');

const membership = (over: Record<string, unknown> = {}) => ({
  organization_id: ORG,
  role: 'owner',
  default_project_role: null,
  plan_tier: 'growth',
  ...over,
});

// The session proof first, then the membership read, as the database would answer them.
function accessResponder(
  sessionRows: readonly Record<string, unknown>[],
  memberRows: readonly Record<string, unknown>[] = [membership()],
): Responder {
  const proof = sessionResponder(sessionRows);
  return (s) => (isMembershipRead(s) ? memberRows : proof(s));
}

// Wrong secret, missing row and expired row: the cases where the cookie proves nothing.
const FAILURES = [
  {
    name: 'a wrong secret',
    rows: [sessionRow({ secret: Buffer.alloc(32, 1) })],
    token: tokenFor(),
  },
  { name: 'a missing row', rows: [], token: tokenFor() },
  {
    name: 'a row for another session id',
    rows: [sessionRow()],
    token: tokenFor(undefined, OTHER_SESSION),
  },
  { name: 'an expired row', rows: [sessionRow({ live: false })], token: tokenFor() },
  {
    name: 'an expired row that is also due a touch',
    rows: [sessionRow({ live: false, touch_due: true })],
    token: tokenFor(),
  },
] as const;

describe('resolveAccess proves the credential before any membership read', () => {
  for (const failure of FAILURES) {
    it(`sends exactly one statement and no write for ${failure.name}`, async () => {
      const { sessions, scripted } = setup(accessResponder(failure.rows));
      await expect(sessions.resolveAccess(failure.token, SLUG)).resolves.toEqual({
        kind: 'signed_out',
      });
      const statements = scripted.statements();
      expect(statements).toHaveLength(1);
      expect(statements[0] !== undefined && isProof(statements[0])).toBe(true);
      expect(scripted.writes()).toEqual([]);
      expect(scripted.events.at(-1)).toEqual({ kind: 'rollback' });
    });
  }

  it('selects only the session row by id in the first statement', async () => {
    const { sessions, scripted } = setup(accessResponder([sessionRow()]));
    await sessions.resolveAccess(tokenFor(), SLUG);
    const [first, second] = scripted.statements();
    expect(first?.sql).toMatch(/from "sessions"/);
    expect(first?.sql).not.toMatch(/join|"users"|"memberships"|"organization/i);
    expect(first?.sql).toMatch(/ where "id" = \$[0-9]+$/);
    expect(second !== undefined && isMembershipRead(second)).toBe(true);
  });

  it('reads the membership by slug for the person in the context, after the match', async () => {
    const { sessions, scripted } = setup(accessResponder([sessionRow()]));
    await sessions.resolveAccess(tokenFor(), SLUG);
    expect(scripted.events[0]).toEqual({ kind: 'begin', scope: 'user', userId: USER });
    const statements = scripted.statements();
    expect(statements).toHaveLength(2);
    const read = statements[1];
    expect(read?.sql).toContain('"memberships"');
    expect(read?.sql).toContain('"organizations"');
    expect(read?.sql).toContain('app.current_user_id()');
    expect(read?.parameters).toContain(SLUG);
    expect(scripted.writes()).toEqual([]);
  });

  it('never opens a transaction for a cookie that does not parse', async () => {
    const { sessions, scripted } = setup(accessResponder([sessionRow()]));
    for (const value of [undefined, '', 'v1.', tokenFor() + 'x']) {
      await expect(sessions.resolveAccess(value, SLUG)).resolves.toEqual({ kind: 'signed_out' });
    }
    expect(scripted.events).toEqual([]);
  });

  it('answers signed_out, not not_member, for a bad cookie and a bad slug together', async () => {
    const { sessions } = setup(accessResponder([]));
    await expect(sessions.resolveAccess(tokenFor(), 'Not A Slug')).resolves.toEqual({
      kind: 'signed_out',
    });
  });

  it.each(['', 'Acme', 'a'.repeat(41), '../x', 7 as unknown as string])(
    'answers not_member for the slug %j after the proof, without a second statement',
    async (slug) => {
      const { sessions, scripted } = setup(accessResponder([sessionRow()]));
      await expect(sessions.resolveAccess(tokenFor(), slug)).resolves.toEqual({
        kind: 'not_member',
      });
      expect(scripted.statements()).toHaveLength(1);
      expect(scripted.writes()).toEqual([]);
    },
  );

  it('answers not_member for an unknown slug and a slug the person is not a member of alike', async () => {
    const { sessions, scripted } = setup(accessResponder([sessionRow()], []));
    await expect(sessions.resolveAccess(tokenFor(), SLUG)).resolves.toEqual({ kind: 'not_member' });
    expect(scripted.statements()).toHaveLength(2);
    expect(scripted.writes()).toEqual([]);
  });
});

describe('resolveAccess answers', () => {
  it('an owner with the organization, the tier and every permission', async () => {
    const { sessions } = setup(accessResponder([sessionRow({ touch_due: true })]));
    const result = await sessions.resolveAccess(tokenFor(), SLUG);
    if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`);
    expect(result.touchDue).toBe(true);
    expect(result.access).toMatchObject({
      organizationId: ORG,
      userId: USER,
      sessionId: SESSION,
      role: 'owner',
      tier: 'growth',
      authenticatedAt: AUTHENTICATED_AT,
    });
    expect(result.access.permissions).toEqual(permissionsFor('owner', new Set(PRODUCTS)));
    expect(Object.isFrozen(result.access)).toBe(true);
  });

  it.each([
    ['admin', null, permissionsFor('admin', new Set(PRODUCTS))],
    ['member', 'viewer', permissionsFor('member', new Set(PRODUCTS))],
    ['member', 'editor', permissionsFor('member', new Set(PRODUCTS))],
    ['member', null, ['org.read']],
  ])('a %s with default project role %s', async (role, defaultRole, expected) => {
    const { sessions } = setup(
      accessResponder([sessionRow()], [membership({ role, default_project_role: defaultRole })]),
    );
    const result = await sessions.resolveAccess(tokenFor(), SLUG);
    if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`);
    expect(result.access.role).toBe(role);
    expect(result.access.permissions).toEqual(expected);
    expect(result.touchDue).toBe(false);
  });

  it('throws AUTH_UNAVAILABLE for a stored role or tier it does not know', async () => {
    for (const bad of [
      { role: 'root' },
      { plan_tier: 'platinum' },
      { default_project_role: 'god' },
    ]) {
      const { sessions } = setup(accessResponder([sessionRow()], [membership(bad)]));
      await expect(sessions.resolveAccess(tokenFor(), SLUG)).rejects.toMatchObject({
        code: 'AUTH_UNAVAILABLE',
      });
    }
  });

  it('throws AUTH_UNAVAILABLE when the database fails', async () => {
    const { sessions } = setup(() => {
      throw new Error('down');
    });
    await expect(sessions.resolveAccess(tokenFor(), SLUG)).rejects.toMatchObject({
      code: 'AUTH_UNAVAILABLE',
    });
  });
});

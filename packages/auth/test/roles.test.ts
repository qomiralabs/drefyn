import { idOf, type IdOf, type ProjectId } from '@drefyn/tenancy';
import { describe, expect, it } from 'vitest';
import { createRoles, type OrgRole } from '../src/index.ts';
import { createTestAuthMailer } from '../src/testing.ts';
import { ORG, access } from './api-key-fixtures.ts';
import { scriptedStore, type Statement } from './scripted-store.ts';
import { USER, capturingLogger } from './session-fixtures.ts';

const fixed = (n: number) => `01890a5d-ac96-774b-bcce-b302099a81${String(n)}`;
const TARGET: IdOf<'mem'> = idOf('mem', fixed(10));
const TARGET_USER = fixed(11);
const ACTOR_MEMBERSHIP = fixed(12);
const PROJECT: ProjectId = idOf('prj', fixed(13));
const KEY_1 = fixed(14);
const KEY_2 = fixed(15);
const AT = new Date('2026-11-03T10:00:00.000Z');

const select = (s: Statement, table: string) =>
  /^select\b/i.test(s.sql) && s.sql.includes(`from "${table}"`);
const isOrgLock = (s: Statement) =>
  select(s, 'organizations') && s.sql.endsWith(' for no key update');
const isTargetRead = (s: Statement) =>
  select(s, 'memberships') &&
  s.sql.includes('"m"."id" = ') &&
  !s.sql.endsWith(' for no key update');
const isActorRead = (s: Statement) =>
  select(s, 'memberships') && s.sql.includes('"user_id" = ') && !s.sql.includes('"m".');
const isOwnerCount = (s: Statement) =>
  select(s, 'memberships') && s.sql.includes('count(*)') && s.sql.includes('"id" <> ');
const isTargetLock = (s: Statement) =>
  select(s, 'memberships') && !s.sql.includes('"m".') && s.sql.endsWith(' for no key update');
const isKeyDelete = (s: Statement) => s.sql.startsWith('delete from "api_keys"');
const isInvitationDelete = (s: Statement) => s.sql.startsWith('delete from "invitations"');
const isInvitationCount = (s: Statement) => select(s, 'invitations') && s.sql.includes('count(*)');
const isRoleUpdate = (s: Statement) => s.sql.startsWith('update "memberships"');
const isMemberDelete = (s: Statement) => s.sql.startsWith('delete from "memberships"');
const isOwnersRead = (s: Statement) =>
  select(s, 'memberships') && s.sql.includes('"u"."email"') && !s.sql.includes('"m"."id" = ');
const isProjectRead = (s: Statement) => select(s, 'projects');
const isProjectRoleRead = (s: Statement) => select(s, 'project_roles');
const isProjectRoleUpsert = (s: Statement) => s.sql.startsWith('insert into "project_roles"');
const isProjectRoleDelete = (s: Statement) => s.sql.startsWith('delete from "project_roles"');

interface World {
  readonly actorRole?: OrgRole | null;
  readonly actorDefault?: string | null;
  readonly target?: { readonly role: OrgRole; readonly userId?: string } | null;
  readonly otherOwners?: number;
  readonly keys?: readonly string[];
  readonly invitations?: number;
  readonly locked?: boolean;
  readonly written?: boolean;
  readonly writeError?: Error;
  readonly owners?: readonly string[];
  readonly project?: boolean;
  readonly projectRole?: string | null;
}

function respond(w: World) {
  return (s: Statement): readonly Record<string, unknown>[] => {
    const target = w.target === undefined ? { role: 'admin' as OrgRole } : w.target;
    if (isOrgLock(s)) return [{ organization_id: ORG }];
    if (isTargetRead(s)) {
      return target === null
        ? []
        : [
            {
              id: TARGET,
              user_id: target.userId ?? TARGET_USER,
              role: target.role,
              display_name: 'Ada Admin',
              email: 'ada@example.com',
            },
          ];
    }
    if (isOwnerCount(s)) return [{ n: w.otherOwners ?? 1 }];
    if (isTargetLock(s)) return w.locked === false ? [] : [{ id: TARGET }];
    if (isActorRead(s)) {
      const r = w.actorRole === undefined ? 'owner' : w.actorRole;
      return r === null
        ? []
        : [{ id: ACTOR_MEMBERSHIP, role: r, default_project_role: w.actorDefault ?? null }];
    }
    if (isKeyDelete(s)) return (w.keys ?? []).map((id) => ({ id }));
    if (isInvitationDelete(s))
      return Array.from({ length: w.invitations ?? 0 }, () => ({ id: fixed(16) }));
    if (isInvitationCount(s)) return [{ n: w.invitations ?? 0 }];
    if (isRoleUpdate(s) || isMemberDelete(s)) {
      if (w.writeError !== undefined) throw w.writeError;
      return w.written === false ? [] : [{ id: TARGET, at: AT }];
    }
    if (isOwnersRead(s)) return (w.owners ?? ['owner@example.com']).map((email) => ({ email }));
    if (isProjectRead(s)) return w.project === false ? [] : [{ id: PROJECT }];
    if (isProjectRoleRead(s)) return w.projectRole == null ? [] : [{ role: w.projectRole }];
    if (isProjectRoleUpsert(s) || isProjectRoleDelete(s)) {
      if (w.writeError !== undefined) throw w.writeError;
      return [{ role: 'editor' }];
    }
    return [];
  };
}

function setup(w: World = {}) {
  const scripted = scriptedStore(respond(w));
  const { logger, lines } = capturingLogger();
  const mail = createTestAuthMailer();
  const roles = createRoles({ store: scripted.store, logger, mailer: mail.mailer });
  return { roles, scripted, lines, mail };
}

const kinds = (statements: readonly Statement[]) =>
  statements.map((s) => {
    for (const [name, test] of [
      ['lock', isOrgLock],
      ['target', isTargetRead],
      ['owners', isOwnersRead],
      ['count', isOwnerCount],
      ['target_lock', isTargetLock],
      ['actor', isActorRead],
      ['keys', isKeyDelete],
      ['invitations', isInvitationDelete],
      ['invitation_count', isInvitationCount],
      ['update', isRoleUpdate],
      ['remove', isMemberDelete],
    ] as const) {
      if (test(s)) return name;
    }
    return s.sql;
  });

// Locks end in "for no key update", so writes are told apart by their first word.
const writesOf = (s: { statements(): Statement[] }) =>
  s.statements().filter((x) => /^(insert|update|delete)\b/i.test(x.sql));

const refusedPolicy = Object.assign(new Error('new row violates row-level security policy'), {
  code: '42501',
});

function failed(result: { ok: true } | { ok: false; error: { code: string } }) {
  if (result.ok) throw new Error('expected a refusal');
  return result.error;
}

describe('changeRole', () => {
  it('locks the organization, reads, locks the target, revokes, then updates, naming the actor', async () => {
    const { roles, scripted } = setup({
      target: { role: 'admin' },
      keys: [KEY_1, KEY_2],
      invitations: 2,
    });
    const result = await roles.changeRole(access('owner'), TARGET, 'member');
    if (!result.ok) throw result.error;
    expect(result.value).toEqual({
      from: 'admin',
      to: 'member',
      revokedKeyIds: [idOf('key', KEY_1), idOf('key', KEY_2)],
      deletedInvitations: 2,
    });
    expect(kinds(scripted.statements())).toEqual([
      'lock',
      'target',
      'actor',
      'target_lock',
      'keys',
      'invitations',
      'update',
      'owners',
    ]);
    expect(scripted.events[0]).toEqual({
      kind: 'begin',
      scope: 'organization',
      organizationId: ORG,
      actorUserId: USER,
    });
    expect(scripted.events.at(-1)).toEqual({ kind: 'commit' });
  });

  it('counts the other owners only when an owner is lowered', async () => {
    const { roles, scripted } = setup({ target: { role: 'owner' }, otherOwners: 1 });
    const result = await roles.changeRole(access('owner'), TARGET, 'admin');
    expect(result.ok).toBe(true);
    expect(kinds(scripted.statements())).toEqual([
      'lock',
      'target',
      'actor',
      'count',
      'target_lock',
      'invitations',
      'update',
      'owners',
    ]);
    // Owner to admin keeps keys: the scopes registry never held management scopes.
    expect(scripted.statements().some(isKeyDelete)).toBe(false);
    const invitations = scripted.statements().find(isInvitationDelete);
    expect(invitations?.parameters).toContain('owner');
  });

  it('deletes every pending invitation of someone made a member, and none of a new owner', async () => {
    const member = setup({ target: { role: 'admin' } });
    await member.roles.changeRole(access('owner'), TARGET, 'member');
    expect(member.scripted.statements().find(isInvitationDelete)?.parameters).not.toContain(
      'owner',
    );
    const owner = setup({ target: { role: 'admin' } });
    await owner.roles.changeRole(access('owner'), TARGET, 'owner');
    expect(owner.scripted.statements().some(isInvitationDelete)).toBe(false);
    expect(owner.scripted.statements().some(isKeyDelete)).toBe(false);
  });

  it.each<[string, World, OrgRole, OrgRole]>([
    ['an admin demoting an owner', { target: { role: 'owner' } }, 'admin', 'member'],
    ['an admin making an owner', { target: { role: 'member' } }, 'admin', 'owner'],
    ['a member changing anyone', { target: { role: 'member' } }, 'member', 'admin'],
    ['someone raising themselves', { target: { role: 'member', userId: USER } }, 'admin', 'admin'],
    [
      'someone no longer a member',
      { actorRole: null, target: { role: 'member' } },
      'owner',
      'admin',
    ],
  ])('refuses %s with AUTH_FORBIDDEN and writes nothing', async (_label, w, actor, to) => {
    const world = { ...w, actorRole: w.actorRole === undefined ? actor : w.actorRole };
    const { roles, scripted, lines } = setup(world);
    expect(failed(await roles.changeRole(access(actor), TARGET, to)).code).toBe('AUTH_FORBIDDEN');
    expect(writesOf(scripted)).toEqual([]);
    expect(scripted.events.at(-1)).toEqual({ kind: 'rollback' });
    expect(lines.find((l) => l.event === 'auth.role_change_refused')?.fields).toMatchObject({
      outcome: 'AUTH_FORBIDDEN',
    });
  });

  // The stored role decides, not the one the guard saw at the start of the request.
  it('refuses an admin demoted since the guard ran', async () => {
    const { roles, scripted } = setup({ actorRole: 'member', target: { role: 'member' } });
    expect(failed(await roles.changeRole(access('admin'), TARGET, 'admin')).code).toBe(
      'AUTH_FORBIDDEN',
    );
    expect(writesOf(scripted)).toEqual([]);
  });

  it('answers AUTH_LAST_OWNER to the last owner lowering themselves', async () => {
    const { roles, scripted } = setup({ target: { role: 'owner', userId: USER }, otherOwners: 0 });
    expect(failed(await roles.changeRole(access('owner'), TARGET, 'admin')).code).toBe(
      'AUTH_LAST_OWNER',
    );
    expect(writesOf(scripted)).toEqual([]);
  });

  it('answers AUTH_NOT_FOUND for a membership not in this organization', async () => {
    const { roles, scripted } = setup({ target: null });
    expect(failed(await roles.changeRole(access('owner'), TARGET, 'admin')).code).toBe(
      'AUTH_NOT_FOUND',
    );
    expect(writesOf(scripted)).toEqual([]);
  });

  it.each<[string, unknown, unknown]>([
    ['an unknown role', TARGET, 'superuser'],
    ['a membership id that is not one', 'mem_x', 'admin'],
  ])('refuses %s with AUTH_INPUT_INVALID before any statement', async (_label, member, role) => {
    const { roles, scripted } = setup();
    const result = await roles.changeRole(access('owner'), member as IdOf<'mem'>, role as OrgRole);
    expect(failed(result).code).toBe('AUTH_INPUT_INVALID');
    expect(scripted.statements()).toEqual([]);
  });

  it('returns the same role as a no op, with no write and no notice', async () => {
    const { roles, scripted, mail } = setup({ target: { role: 'admin' } });
    const result = await roles.changeRole(access('owner'), TARGET, 'admin');
    if (!result.ok) throw result.error;
    expect(result.value).toEqual({
      from: 'admin',
      to: 'admin',
      revokedKeyIds: [],
      deletedInvitations: 0,
    });
    expect(writesOf(scripted)).toEqual([]);
    expect(mail.notices).toEqual([]);
  });

  // A guard that refuses after the code allowed it is an invariant breach, not a person to
  // argue with.
  it.each<[string, World]>([
    ['the target lock finds no row', { locked: false }],
    ['the update touches no row', { written: false }],
    ['the update is refused by a policy', { writeError: refusedPolicy }],
  ])('answers AUTH_FORBIDDEN and logs a guard refusal when %s', async (_label, w) => {
    const { roles, lines, mail } = setup({ target: { role: 'member' }, ...w });
    expect(failed(await roles.changeRole(access('owner'), TARGET, 'admin')).code).toBe(
      'AUTH_FORBIDDEN',
    );
    const guard = lines.find((l) => l.event === 'auth.role_guard_refused');
    expect(String(guard?.fields['membershipId'])).toMatch(/^mem_/);
    expect(mail.notices).toEqual([]);
  });

  it('answers AUTH_UNAVAILABLE when the database fails', async () => {
    const { roles } = setup({ writeError: new Error('connection lost') });
    expect(failed(await roles.changeRole(access('owner'), TARGET, 'member')).code).toBe(
      'AUTH_UNAVAILABLE',
    );
  });

  it('tells every owner about a new owner, by name, after the commit', async () => {
    const { roles, scripted, mail } = setup({
      target: { role: 'admin' },
      owners: ['one@example.com', 'two@example.com'],
    });
    await roles.changeRole(access('owner'), TARGET, 'owner');
    expect(mail.notices).toEqual([
      {
        to: 'one@example.com',
        notice: {
          kind: 'owner_added',
          organizationId: ORG,
          membershipId: TARGET,
          memberName: 'Ada Admin',
          at: AT,
        },
      },
      {
        to: 'two@example.com',
        notice: {
          kind: 'owner_added',
          organizationId: ORG,
          membershipId: TARGET,
          memberName: 'Ada Admin',
          at: AT,
        },
      },
    ]);
    expect(scripted.events.filter((e) => e.kind === 'commit')).toHaveLength(1);
  });

  it('tells every owner when a demotion revoked keys, and nobody when it revoked none', async () => {
    const withKeys = setup({ target: { role: 'admin' }, keys: [KEY_1] });
    await withKeys.roles.changeRole(access('owner'), TARGET, 'member');
    expect(withKeys.mail.notices.map((n) => n.notice)).toEqual([
      {
        kind: 'member_keys_revoked',
        organizationId: ORG,
        membershipId: TARGET,
        memberName: 'Ada Admin',
        revokedKeys: 1,
        at: AT,
      },
    ]);
    const without = setup({ target: { role: 'admin' } });
    await without.roles.changeRole(access('owner'), TARGET, 'member');
    expect(without.mail.notices).toEqual([]);
  });

  it('keeps the change and logs when a notice cannot be sent', async () => {
    const { roles, mail, lines } = setup({ target: { role: 'admin' } });
    mail.failNext();
    const result = await roles.changeRole(access('owner'), TARGET, 'owner');
    expect(result.ok).toBe(true);
    expect(lines.some((l) => l.event === 'auth.member_notice_failed')).toBe(true);
  });

  it('logs ids and roles only, never a name or an address', async () => {
    const { roles, lines } = setup({ target: { role: 'admin' }, keys: [KEY_1] });
    await roles.changeRole(access('owner'), TARGET, 'member');
    const changed = lines.find((l) => l.event === 'auth.role_changed');
    expect(changed?.fields).toMatchObject({ from: 'admin', to: 'member', revokedKeys: 1 });
    expect(JSON.stringify(lines)).not.toMatch(/Ada|@example\.com/);
  });
});

describe('removeMember', () => {
  it('locks, reads, revokes keys before the membership goes, then notifies every owner', async () => {
    const { roles, scripted, mail } = setup({
      target: { role: 'member' },
      keys: [KEY_1],
      invitations: 3,
      owners: ['one@example.com'],
    });
    const result = await roles.removeMember(access('owner'), TARGET);
    if (!result.ok) throw result.error;
    expect(result.value).toEqual({ revokedKeyIds: [idOf('key', KEY_1)], deletedInvitations: 3 });
    expect(kinds(scripted.statements())).toEqual([
      'lock',
      'target',
      'actor',
      'target_lock',
      'keys',
      'invitation_count',
      'remove',
      'owners',
    ]);
    expect(scripted.events[0]).toMatchObject({ actorUserId: USER });
    expect(mail.notices).toEqual([
      {
        to: 'one@example.com',
        notice: {
          kind: 'member_removed',
          organizationId: ORG,
          membershipId: TARGET,
          memberName: 'Ada Admin',
          revokedKeys: 1,
          at: AT,
        },
      },
    ]);
  });

  it('takes no options: an extra argument cannot keep the keys', async () => {
    const { roles, scripted } = setup({ target: { role: 'member' }, keys: [KEY_1] });
    const remove = roles.removeMember.bind(roles) as (
      ...args: unknown[]
    ) => ReturnType<typeof roles.removeMember>;
    await remove(access('owner'), TARGET, { keys: 'keep' });
    expect(scripted.statements().some(isKeyDelete)).toBe(true);
  });

  it.each<[string, World, OrgRole]>([
    ['an admin removing an owner', { target: { role: 'owner' } }, 'admin'],
    ['a member removing anyone', { target: { role: 'member' } }, 'member'],
    ['someone removing themselves', { target: { role: 'admin', userId: USER } }, 'owner'],
  ])('refuses %s with AUTH_FORBIDDEN and writes nothing', async (_label, w, actor) => {
    const { roles, scripted } = setup({ ...w, actorRole: actor });
    expect(failed(await roles.removeMember(access(actor), TARGET)).code).toBe('AUTH_FORBIDDEN');
    expect(writesOf(scripted)).toEqual([]);
  });

  it('answers AUTH_LAST_OWNER and AUTH_NOT_FOUND without writing', async () => {
    const last = setup({ target: { role: 'owner' }, otherOwners: 0 });
    expect(failed(await last.roles.removeMember(access('owner'), TARGET)).code).toBe(
      'AUTH_LAST_OWNER',
    );
    expect(writesOf(last.scripted)).toEqual([]);
    const gone = setup({ target: null });
    expect(failed(await gone.roles.removeMember(access('owner'), TARGET)).code).toBe(
      'AUTH_NOT_FOUND',
    );
  });

  it('answers AUTH_FORBIDDEN and logs when the delete touches no row', async () => {
    const { roles, lines } = setup({ target: { role: 'member' }, written: false });
    expect(failed(await roles.removeMember(access('owner'), TARGET)).code).toBe('AUTH_FORBIDDEN');
    expect(lines.some((l) => l.event === 'auth.role_guard_refused')).toBe(true);
  });
});

describe('setProjectRole', () => {
  it('upserts the row for a member, naming the actor', async () => {
    const { roles, scripted } = setup({ target: { role: 'member' } });
    const result = await roles.setProjectRole(access('admin'), TARGET, PROJECT, 'editor');
    expect(result.ok).toBe(true);
    const upsert = scripted.statements().find(isProjectRoleUpsert);
    expect(upsert?.parameters).toEqual(expect.arrayContaining([ORG, TARGET, PROJECT, 'editor']));
    expect(upsert?.sql).toContain('on conflict');
    expect(scripted.events[0]).toMatchObject({ actorUserId: USER });
  });

  it('deletes the row for null, so the default applies again', async () => {
    const { roles, scripted } = setup({ target: { role: 'member' } });
    expect((await roles.setProjectRole(access('owner'), TARGET, PROJECT, null)).ok).toBe(true);
    expect(scripted.statements().some(isProjectRoleDelete)).toBe(true);
    expect(scripted.statements().some(isProjectRoleUpsert)).toBe(false);
  });

  it.each<[string, World, OrgRole, unknown, string]>([
    [
      'a member acting',
      { actorRole: 'member', target: { role: 'member' } },
      'member',
      'editor',
      'AUTH_FORBIDDEN',
    ],
    [
      'an owner or admin target',
      { target: { role: 'admin' } },
      'owner',
      'editor',
      'AUTH_INPUT_INVALID',
    ],
    [
      'an unknown project',
      { target: { role: 'member' }, project: false },
      'owner',
      'editor',
      'AUTH_INPUT_INVALID',
    ],
    ['an unknown membership', { target: null }, 'owner', 'editor', 'AUTH_NOT_FOUND'],
    [
      'a refused write',
      { target: { role: 'member' }, writeError: refusedPolicy },
      'owner',
      'editor',
      'AUTH_FORBIDDEN',
    ],
  ])('refuses %s', async (_label, w, actor, role, code) => {
    const { roles } = setup({ ...w, actorRole: w.actorRole ?? actor });
    const result = await roles.setProjectRole(access(actor), TARGET, PROJECT, role as 'editor');
    expect(failed(result).code).toBe(code);
  });

  it('refuses an unknown project role before any statement', async () => {
    const { roles, scripted } = setup();
    const result = await roles.setProjectRole(access('owner'), TARGET, PROJECT, 'owner' as 'admin');
    expect(failed(result).code).toBe('AUTH_INPUT_INVALID');
    expect(scripted.statements()).toEqual([]);
  });
});

describe('projectRole', () => {
  it('is admin for owners and admins on every project', async () => {
    for (const role of ['owner', 'admin'] as const) {
      const { roles } = setup({ actorRole: role, projectRole: 'viewer' });
      expect(await roles.projectRole(access(role), PROJECT)).toBe('admin');
    }
  });

  it('takes the project row over the default, and the default without a row', async () => {
    const row = setup({ actorRole: 'member', actorDefault: 'viewer', projectRole: 'editor' });
    expect(await row.roles.projectRole(access('member', 'viewer'), PROJECT)).toBe('editor');
    const fallback = setup({ actorRole: 'member', actorDefault: 'viewer' });
    expect(await fallback.roles.projectRole(access('member', 'viewer'), PROJECT)).toBe('viewer');
    const none = setup({ actorRole: 'member', actorDefault: null });
    expect(await none.roles.projectRole(access('member'), PROJECT)).toBeNull();
  });

  it('is null for a project the organization does not have, or a person no longer in it', async () => {
    expect(await setup({ project: false }).roles.projectRole(access('owner'), PROJECT)).toBeNull();
    expect(await setup({ actorRole: null }).roles.projectRole(access('owner'), PROJECT)).toBeNull();
  });
});

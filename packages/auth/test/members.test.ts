import { idOf } from '@drefyn/tenancy';
import { describe, expect, it } from 'vitest';
import { createMembers, type OrgRole } from '../src/index.ts';
import { ORG, PROJECT_A, access, isRecentRead } from './api-key-fixtures.ts';
import { scriptedStore, type Statement } from './scripted-store.ts';
import { USER, capturingLogger } from './session-fixtures.ts';

const fixed = (n: number) => `01890a5d-ac96-774b-bcce-b302099a82${String(n)}`;
const MEMBER = idOf('mem', fixed(10));
const OTHER_MEMBER = idOf('mem', fixed(11));
const INVITATION = idOf('inv', fixed(12));
const JOINED = new Date('2026-10-03T09:00:00.000Z');
const EXPIRES = new Date('2026-11-10T09:00:00.000Z');

const from = (s: Statement, table: string) =>
  /^select\b/i.test(s.sql) && s.sql.includes(`from "${table}"`);
const isActorRead = (s: Statement) => from(s, 'memberships') && !s.sql.includes(' as "m"');
const isMembersRead = (s: Statement) => from(s, 'memberships') && s.sql.includes(' as "m"');

interface World {
  readonly actorRole?: OrgRole | null;
  readonly invitationRole?: OrgRole | null;
  readonly deleted?: boolean;
  readonly targetRole?: OrgRole | null;
  readonly recent?: boolean;
  readonly fail?: boolean;
}

function setup(w: World = {}) {
  const store = scriptedStore((s) => {
    if (w.fail === true) throw new Error('down');
    if (isRecentRead(s)) return [{ recent: w.recent ?? true }];
    if (isActorRead(s)) {
      const role = w.actorRole === undefined ? 'owner' : w.actorRole;
      return role === null ? [] : [{ role }];
    }
    if (isMembersRead(s) && s.sql.includes('"m"."id" = ')) {
      return w.targetRole === null ? [] : [{ id: MEMBER, role: w.targetRole ?? 'member' }];
    }
    if (isMembersRead(s)) {
      return [
        {
          id: MEMBER,
          user_id: USER,
          role: 'owner',
          default_project_role: null,
          created_at: JOINED,
          display_name: 'Maya Okafor',
          email: 'maya@acme.dev',
        },
        {
          id: OTHER_MEMBER,
          user_id: fixed(13),
          role: 'member',
          default_project_role: 'editor',
          created_at: JOINED,
          display_name: null,
          email: 'sam@acme.dev',
        },
      ];
    }
    if (from(s, 'project_roles')) {
      return [{ membership_id: OTHER_MEMBER, target_project_id: PROJECT_A, role: 'admin' }];
    }
    if (from(s, 'invitations') && s.sql.includes('"expired"')) {
      return [
        {
          id: INVITATION,
          email_normalized: 'jordan@acme.dev',
          role: 'member',
          default_project_role: 'editor',
          expires_at: EXPIRES,
          expired: false,
          display_name: 'Maya Okafor',
          email: 'maya@acme.dev',
        },
      ];
    }
    if (from(s, 'invitations')) {
      return w.invitationRole === null
        ? []
        : [
            {
              email_normalized: 'jordan@acme.dev',
              role: w.invitationRole ?? 'member',
              default_project_role: 'editor',
            },
          ];
    }
    if (from(s, 'projects')) {
      return [{ id: PROJECT_A, name: 'Payments API docs', product: 'docs' }];
    }
    if (s.sql.startsWith('delete from "invitations"')) {
      return w.deleted === false ? [] : [{ id: INVITATION }];
    }
    if (s.sql.startsWith('update "memberships"')) return [{ id: MEMBER }];
    return [];
  });
  const { logger, lines } = capturingLogger();
  return { members: createMembers({ store: store.store, logger }), store, lines };
}

describe('listMembers', () => {
  it('lists people with their project roles and the address where no name is set', async () => {
    const { members } = setup();
    const list = await members.listMembers(access());
    if (!list.ok) throw list.error;
    expect(list.value.members.map((m) => [m.name, m.role, m.self])).toEqual([
      ['Maya Okafor', 'owner', true],
      ['sam@acme.dev', 'member', false],
    ]);
    expect(list.value.members[1]?.projectRoles).toEqual([{ projectId: PROJECT_A, role: 'admin' }]);
  });

  it('lists invitations for someone who manages people', async () => {
    const { members } = setup();
    const list = await members.listMembers(access('admin'));
    if (!list.ok) throw list.error;
    expect(list.value.invitations).toEqual([
      {
        invitationId: INVITATION,
        email: 'jordan@acme.dev',
        role: 'member',
        defaultProjectRole: 'editor',
        invitedBy: 'Maya Okafor',
        expiresAt: EXPIRES,
        expired: false,
      },
    ]);
  });

  it('never reads invitations for a member', async () => {
    const { members, store } = setup();
    const list = await members.listMembers(access('member'));
    if (!list.ok) throw list.error;
    expect(list.value.invitations).toEqual([]);
    expect(store.statements().some((s) => from(s, 'invitations'))).toBe(false);
  });

  it('reads only inside the organization', async () => {
    const { members, store } = setup();
    await members.listMembers(access());
    expect(store.events[0]).toEqual({ kind: 'begin', scope: 'organization', organizationId: ORG });
    expect(store.writes()).toEqual([]);
  });

  it('turns a database failure into unavailable', async () => {
    const { members } = setup({ fail: true });
    const list = await members.listMembers(access());
    expect(!list.ok && list.error.code).toBe('AUTH_UNAVAILABLE');
  });
});

describe('listProjects', () => {
  it('lists projects for someone who manages keys', async () => {
    const { members } = setup();
    expect(await members.listProjects(access('admin'))).toEqual({
      ok: true,
      value: [{ projectId: PROJECT_A, name: 'Payments API docs', product: 'docs' }],
    });
  });

  it('refuses a member before any statement', async () => {
    const { members, store } = setup();
    const list = await members.listProjects(access('member'));
    expect(!list.ok && list.error.code).toBe('AUTH_FORBIDDEN');
    expect(store.statements()).toEqual([]);
  });

  it('turns a database failure into unavailable', async () => {
    const { members } = setup({ fail: true });
    const list = await members.listProjects(access());
    expect(!list.ok && list.error.code).toBe('AUTH_UNAVAILABLE');
  });
});

describe('listReachableProjects', () => {
  const row = {
    id: PROJECT_A,
    slug: 'payments-api',
    name: 'Payments API docs',
    product: 'docs',
    read_only_since: null,
  };
  const read = (over: object = {}) => {
    const store = scriptedStore(() => [{ ...row, ...over }]);
    const { logger } = capturingLogger();
    return { members: createMembers({ store: store.store, logger }), store };
  };

  it('reads under the organization and returns what the shell draws', async () => {
    const { members, store } = read();
    expect(await members.listReachableProjects(access('admin'))).toEqual({
      ok: true,
      value: [
        {
          projectId: PROJECT_A,
          slug: 'payments-api',
          name: 'Payments API docs',
          product: 'docs',
          readOnly: false,
        },
      ],
    });
    expect(store.events[0]).toEqual({ kind: 'begin', scope: 'organization', organizationId: ORG });
    expect(store.writes()).toEqual([]);
  });

  it('carries read only state from the project row', async () => {
    const { members } = read({ read_only_since: JOINED });
    const list = await members.listReachableProjects(access('admin'));
    expect(list.ok && list.value[0]?.readOnly).toBe(true);
  });

  it('asks for every product the person may read', async () => {
    const { members, store } = read();
    await members.listReachableProjects(access('owner'));
    const parameters = store.statements()[0]?.parameters;
    expect(parameters).toEqual(expect.arrayContaining(['docs', 'studio', 'status']));
  });

  it('holds a person with no product to their own project roles', async () => {
    const { members, store } = read();
    await members.listReachableProjects(access('member'));
    const statement = store.statements()[0];
    expect(statement?.sql).toContain('"project_roles"');
    expect(statement?.parameters).toEqual(expect.arrayContaining([USER]));
    expect(statement?.parameters).not.toEqual(expect.arrayContaining(['docs']));
  });

  it('turns a database failure into unavailable', async () => {
    const { members } = setup({ fail: true });
    const list = await members.listReachableProjects(access());
    expect(!list.ok && list.error.code).toBe('AUTH_UNAVAILABLE');
  });

  it('refuses a product it does not know instead of drawing it', async () => {
    const { members } = read({ product: 'blog' });
    const list = await members.listReachableProjects(access());
    expect(!list.ok && list.error.code).toBe('AUTH_UNAVAILABLE');
  });
});

describe('withdrawInvitation', () => {
  it('deletes the row and returns what an undo needs', async () => {
    const { members, lines } = setup();
    const done = await members.withdrawInvitation(access(), INVITATION);
    expect(done).toEqual({
      ok: true,
      value: { email: 'jordan@acme.dev', role: 'member', defaultProjectRole: 'editor' },
    });
    expect(lines.some((l) => l.event === 'auth.invitation_withdrawn')).toBe(true);
    expect(JSON.stringify(lines)).not.toContain('jordan');
  });

  it('refuses a member by the guard context, before any statement', async () => {
    const { members, store } = setup();
    const done = await members.withdrawInvitation(access('member'), INVITATION);
    expect(!done.ok && done.error.code).toBe('AUTH_FORBIDDEN');
    expect(store.statements()).toEqual([]);
  });

  it('goes by the stored role, not the one the guard saw', async () => {
    const { members, store } = setup({ actorRole: 'member' });
    const done = await members.withdrawInvitation(access('admin'), INVITATION);
    expect(!done.ok && done.error.code).toBe('AUTH_FORBIDDEN');
    expect(store.writes()).toEqual([]);
  });

  it('refuses a removed actor', async () => {
    const { members } = setup({ actorRole: null });
    const done = await members.withdrawInvitation(access('admin'), INVITATION);
    expect(!done.ok && done.error.code).toBe('AUTH_FORBIDDEN');
  });

  it('keeps an admin from withdrawing an owner invitation', async () => {
    const { members, store } = setup({ actorRole: 'admin', invitationRole: 'owner' });
    const done = await members.withdrawInvitation(access('admin'), INVITATION);
    expect(!done.ok && done.error.code).toBe('AUTH_FORBIDDEN');
    expect(store.writes()).toEqual([]);
  });

  it('answers an unknown or already withdrawn invitation as not found', async () => {
    const unknown = setup({ invitationRole: null });
    const first = await unknown.members.withdrawInvitation(access(), INVITATION);
    expect(!first.ok && first.error.code).toBe('AUTH_NOT_FOUND');
    const raced = setup({ deleted: false });
    const second = await raced.members.withdrawInvitation(access(), INVITATION);
    expect(!second.ok && second.error.code).toBe('AUTH_NOT_FOUND');
  });

  it('refuses a malformed id', async () => {
    const { members } = setup();
    const done = await members.withdrawInvitation(access(), 'nope' as typeof INVITATION);
    expect(!done.ok && done.error.code).toBe('AUTH_INPUT_INVALID');
  });

  it('turns a database failure into unavailable', async () => {
    const { members } = setup({ fail: true });
    const done = await members.withdrawInvitation(access(), INVITATION);
    expect(!done.ok && done.error.code).toBe('AUTH_UNAVAILABLE');
  });
});

describe('setDefaultProjectRole', () => {
  it('sets the role for a member', async () => {
    const { members, store } = setup();
    expect(await members.setDefaultProjectRole(access(), MEMBER, 'viewer')).toEqual({
      ok: true,
      value: undefined,
    });
    expect(store.writes()).toHaveLength(1);
  });

  it('takes null for no project until someone chooses', async () => {
    const { members, store } = setup();
    const done = await members.setDefaultProjectRole(access(), MEMBER, null);
    expect(done.ok).toBe(true);
    expect(store.writes()[0]?.parameters).toContain(null);
  });

  it('needs a recent sign in', async () => {
    const { members, store } = setup({ recent: false });
    const done = await members.setDefaultProjectRole(access(), MEMBER, 'viewer');
    expect(!done.ok && done.error.code).toBe('AUTH_RECENT_AUTH_REQUIRED');
    expect(store.writes()).toEqual([]);
  });

  it('refuses a member by the guard context and by the stored role', async () => {
    const first = setup();
    const done = await first.members.setDefaultProjectRole(access('member'), MEMBER, 'viewer');
    expect(!done.ok && done.error.code).toBe('AUTH_FORBIDDEN');
    const stale = setup({ actorRole: 'member' });
    const again = await stale.members.setDefaultProjectRole(access('admin'), MEMBER, 'viewer');
    expect(!again.ok && again.error.code).toBe('AUTH_FORBIDDEN');
  });

  it('refuses an owner or admin row, whose project access never reads this', async () => {
    const { members, store } = setup({ targetRole: 'admin' });
    const done = await members.setDefaultProjectRole(access(), MEMBER, 'viewer');
    expect(!done.ok && done.error.code).toBe('AUTH_INPUT_INVALID');
    expect(store.writes()).toEqual([]);
  });

  it('answers an unknown member as not found', async () => {
    const { members } = setup({ targetRole: null });
    const done = await members.setDefaultProjectRole(access(), MEMBER, 'viewer');
    expect(!done.ok && done.error.code).toBe('AUTH_NOT_FOUND');
  });

  it('refuses a bad id or role before any statement', async () => {
    const { members, store } = setup();
    const badId = await members.setDefaultProjectRole(access(), 'x' as typeof MEMBER, 'viewer');
    expect(!badId.ok && badId.error.code).toBe('AUTH_INPUT_INVALID');
    const badRole = await members.setDefaultProjectRole(access(), MEMBER, 'admin' as 'viewer');
    expect(!badRole.ok && badRole.error.code).toBe('AUTH_INPUT_INVALID');
    expect(store.statements()).toEqual([]);
  });
});

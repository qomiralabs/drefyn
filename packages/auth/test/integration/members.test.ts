import { randomBytes } from 'node:crypto';
import { idOf } from '@drefyn/tenancy';
import { beforeAll, expect, it } from 'vitest';
import type { AccessContext, OrgRole } from '../../src/index.ts';
import { addProjects, input, newOrg, signIn, type Org } from './support/api-keys.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';

const fresh = harness();
let h: Harness;

async function join(org: Org, role: OrgRole, defaultProjectRole: string | null = null) {
  const { session, cookie, sessions } = await signIn(h);
  const fallback = defaultProjectRole === null ? 'null' : `'${defaultProjectRole}'`;
  const id = await h.sql(
    `insert into app.memberships (organization_id, user_id, role, default_project_role)
     values ('${org.organizationId}', '${session.userId}', '${role}', ${fallback}) returning id;`,
  );
  const resolved = await sessions.resolveAccess(cookie, org.slug);
  if (resolved.kind !== 'ok') throw new Error(`member did not resolve: ${resolved.kind}`);
  return {
    access: resolved.access,
    session,
    membership: idOf('mem', id.trim().split('\n')[0] ?? ''),
  };
}

const address = () => `i${randomBytes(5).toString('hex')}@example.com`;

async function invite(from: AccessContext, role: OrgRole = 'member') {
  const made = await h.invitations().invite(from, {
    email: address(),
    role,
    defaultProjectRole: 'viewer',
  });
  if (!made.ok || made.value.kind !== 'sent') throw new Error('invite failed');
  return made.value.invitation.invitationId;
}

describeWithStack('account and members', () => {
  beforeAll(async () => {
    h = await fresh();
  });

  it('a person reads and renames only their own account, and never sees the hash', async () => {
    const { session } = await signIn(h);
    const account = h.account();
    const named = await account.setDisplayName(session, { name: 'Maya Okafor' });
    expect(named.ok).toBe(true);
    const read = await account.readAccount(session);
    if (!read.ok) throw read.error;
    expect(read.value).toMatchObject({
      displayName: 'Maya Okafor',
      email: session.email,
      passwordSetAt: null,
      identities: [],
    });
    expect(read.value.confirmedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(read.value)).not.toContain('argon2');
  });

  it('lists people and invitations of one organization only', async () => {
    const org = await newOrg(h);
    const other = await newOrg(h);
    const member = await join(org, 'member', 'editor');
    const waiting = await invite(org.owner);
    await invite(other.owner);
    const list = await h.members().listMembers(org.owner);
    if (!list.ok) throw list.error;
    expect(list.value.members.map((m) => m.membershipId)).toContain(member.membership);
    expect(list.value.members).toHaveLength(2);
    expect(list.value.members.filter((m) => m.self)).toHaveLength(1);
    expect(list.value.invitations.map((i) => i.invitationId)).toEqual([waiting]);
    expect(list.value.invitations[0]?.expired).toBe(false);
  });

  it('shows a member the people and no invitations', async () => {
    const org = await newOrg(h);
    const member = await join(org, 'member');
    await invite(org.owner);
    const list = await h.members().listMembers(member.access);
    if (!list.ok) throw list.error;
    expect(list.value.members).toHaveLength(2);
    expect(list.value.invitations).toEqual([]);
  });

  it('withdraws an invitation, gives the seat back, and a second try finds nothing', async () => {
    const org = await newOrg(h);
    const invitation = await invite(org.owner);
    const before = await h.invitations().seatUsage(org.owner);
    const done = await h.members().withdrawInvitation(org.owner, invitation);
    if (!done.ok) throw done.error;
    expect(done.value).toMatchObject({ role: 'member', defaultProjectRole: 'viewer' });
    const after = await h.invitations().seatUsage(org.owner);
    expect(after.used).toBe(before.used - 1);
    const again = await h.members().withdrawInvitation(org.owner, invitation);
    expect(!again.ok && again.error.code).toBe('AUTH_NOT_FOUND');
  });

  it('keeps an admin from withdrawing an owner invitation', async () => {
    const org = await newOrg(h);
    const admin = await join(org, 'admin');
    const invitation = await invite(org.owner, 'owner');
    const done = await h.members().withdrawInvitation(admin.access, invitation);
    expect(!done.ok && done.error.code).toBe('AUTH_FORBIDDEN');
  });

  it('never reaches across organizations', async () => {
    const org = await newOrg(h);
    const other = await newOrg(h);
    const invitation = await invite(other.owner);
    const done = await h.members().withdrawInvitation(org.owner, invitation);
    expect(!done.ok && done.error.code).toBe('AUTH_NOT_FOUND');
    const member = await join(other, 'member');
    const set = await h.members().setDefaultProjectRole(org.owner, member.membership, 'viewer');
    expect(!set.ok && set.error.code).toBe('AUTH_NOT_FOUND');
  });

  it('sets a default project role through the actor policies, and shows it', async () => {
    const org = await newOrg(h);
    const member = await join(org, 'member', 'editor');
    const set = await h.members().setDefaultProjectRole(org.owner, member.membership, 'viewer');
    if (!set.ok) throw set.error;
    const list = await h.members().listMembers(org.owner);
    if (!list.ok) throw list.error;
    const row = list.value.members.find((m) => m.membershipId === member.membership);
    expect(row?.defaultProjectRole).toBe('viewer');
  });

  it('lists projects for someone who hands out access', async () => {
    const org = await newOrg(h);
    await addProjects(h, org.organizationId, 2);
    const list = await h.members().listProjects(org.owner);
    if (!list.ok) throw list.error;
    expect(list.value).toHaveLength(2);
  });

  it('finds the keys a removal will revoke through the list filter', async () => {
    const org = await newOrg(h);
    const admin = await join(org, 'admin');
    const made = await h.apiKeys().createApiKey(admin.access, input());
    if (!made.ok) throw made.error;
    const keys = await h.apiKeys().listApiKeys(org.owner, { createdBy: [admin.membership] });
    if (!keys.ok) throw keys.error;
    expect(keys.value.items.map((k) => k.keyId)).toEqual([made.value.key.keyId]);
  });
});

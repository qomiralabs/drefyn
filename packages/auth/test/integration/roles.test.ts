import { idOf, type IdOf, type ProjectId } from '@drefyn/tenancy';
import { beforeAll, expect, it } from 'vitest';
import type { AccessContext, OrgRole } from '../../src/index.ts';
import { addProjects, input, newOrg, signIn, type Org } from './support/api-keys.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';

const fresh = harness();
let h: Harness;

interface Person {
  readonly access: AccessContext;
  readonly cookie: string;
  readonly membership: IdOf<'mem'>;
}

// Another person in the organization with the given role, reached the way the guard does.
async function join(
  org: Org,
  role: OrgRole,
  defaultProjectRole: 'editor' | 'viewer' | null = null,
): Promise<Person> {
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
    cookie,
    membership: idOf('mem', id.trim().split('\n')[0] ?? ''),
  };
}

async function ownerMembership(org: Org): Promise<IdOf<'mem'>> {
  return idOf(
    'mem',
    await h.sql(
      `select id from app.memberships where organization_id = '${org.organizationId}'
         and user_id = '${org.owner.userId}';`,
    ),
  );
}

const count = async (sql: string) => Number(await h.sql(sql));
const owners = (org: Org) =>
  count(
    `select count(*) from app.memberships where organization_id = '${org.organizationId}' and role = 'owner';`,
  );

async function keyOf(person: AccessContext, projectIds?: readonly ProjectId[]) {
  const made = await h
    .apiKeys()
    .createApiKey(
      person,
      projectIds === undefined ? input() : input({ projectScope: 'listed', projectIds }),
    );
  if (!made.ok) throw made.error;
  return made.value.key.keyId;
}

async function inviteFrom(person: AccessContext, role: OrgRole) {
  const made = await h.invitations().invite(person, {
    email: `i${String(Math.random()).slice(2, 10)}@example.com`,
    role,
    defaultProjectRole: null,
  });
  if (!made.ok) throw made.error;
}

describeWithStack('roles and removal against Postgres', () => {
  beforeAll(async () => {
    h = await fresh();
  });

  // Each round runs demotions and removals of owners at once from every owner; whatever
  // order the lock gives them, one owner is left.
  it('never leaves an organization without an owner under 20 parallel changes', async () => {
    for (const n of [2, 3, 4, 5]) {
      const org = await newOrg(h);
      const team: Person[] = [
        { access: org.owner, cookie: '', membership: await ownerMembership(org) },
      ];
      for (let i = 1; i < n; i += 1) team.push(await join(org, 'owner'));
      const roles = h.roles();
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => {
          const actor = team[i % n];
          const target = team[(i + Math.floor(i / n)) % n];
          if (actor === undefined || target === undefined) throw new Error('no person');
          return i % 2 === 0
            ? roles.changeRole(actor.access, target.membership, i % 4 === 0 ? 'member' : 'admin')
            : roles.removeMember(actor.access, target.membership);
        }),
      );
      for (const r of results) {
        if (!r.ok) {
          expect(['AUTH_LAST_OWNER', 'AUTH_FORBIDDEN', 'AUTH_NOT_FOUND'], r.error.code).toContain(
            r.error.code,
          );
        }
      }
      expect(await owners(org), `with ${String(n)} owners`).toBeGreaterThanOrEqual(1);
      // Not vacuous: some changes went through.
      expect(results.some((r) => r.ok)).toBe(true);
    }
  });

  it('lets an owner step down while another owner exists, and refuses the last one', async () => {
    const org = await newOrg(h);
    const self = await ownerMembership(org);
    const alone = await h.roles().changeRole(org.owner, self, 'admin');
    expect(alone.ok ? 'ok' : alone.error.code).toBe('AUTH_LAST_OWNER');
    const other = await join(org, 'owner');
    const stepped = await h.roles().changeRole(org.owner, self, 'admin');
    expect(stepped.ok).toBe(true);
    expect(await owners(org)).toBe(1);
    const back = await h.roles().changeRole(other.access, self, 'owner');
    expect(back.ok).toBe(true);
  });

  it('keeps admins off owners at every step', async () => {
    const org = await newOrg(h);
    const owner = await ownerMembership(org);
    const admin = await join(org, 'admin');
    const member = await join(org, 'member');
    const roles = h.roles();
    for (const result of [
      await roles.changeRole(admin.access, owner, 'member'),
      await roles.changeRole(admin.access, member.membership, 'owner'),
      await roles.changeRole(admin.access, admin.membership, 'owner'),
      await roles.removeMember(admin.access, owner),
      await roles.changeRole(member.access, member.membership, 'admin'),
    ]) {
      expect(result.ok ? 'ok' : result.error.code).toBe('AUTH_FORBIDDEN');
    }
    expect((await roles.changeRole(admin.access, member.membership, 'admin')).ok).toBe(true);
  });

  it('lets a project role override the default role on that one project only', async () => {
    const org = await newOrg(h);
    const [one, two] = await addProjects(h, org.organizationId, 2);
    if (one === undefined || two === undefined) throw new Error('no projects');
    const member = await join(org, 'member', 'viewer');
    const roles = h.roles();
    expect((await roles.setProjectRole(org.owner, member.membership, one, 'editor')).ok).toBe(true);
    expect(await roles.projectRole(member.access, one)).toBe('editor');
    expect(await roles.projectRole(member.access, two)).toBe('viewer');
    expect(await roles.projectRole(org.owner, two)).toBe('admin');
    expect((await roles.setProjectRole(org.owner, member.membership, one, null)).ok).toBe(true);
    expect(await roles.projectRole(member.access, one)).toBe('viewer');
  });

  it('removes a member with every key they made, its project rows and their invitations, and tells every owner', async () => {
    const org = await newOrg(h);
    const [project] = await addProjects(h, org.organizationId, 1);
    if (project === undefined) throw new Error('no project');
    const second = await join(org, 'owner');
    const admin = await join(org, 'admin');
    const keys = [await keyOf(admin.access), await keyOf(admin.access, [project])];
    await inviteFrom(admin.access, 'member');
    const before = h.mail.notices.length;
    const result = await h.roles().removeMember(org.owner, admin.membership);
    if (!result.ok) throw result.error;
    expect([...result.value.revokedKeyIds].sort()).toEqual([...keys].sort());
    expect(result.value.deletedInvitations).toBe(1);
    const scope = `organization_id = '${org.organizationId}'`;
    expect(await count(`select count(*) from app.api_keys where ${scope};`)).toBe(0);
    expect(await count(`select count(*) from app.api_key_projects where ${scope};`)).toBe(0);
    expect(await count(`select count(*) from app.invitations where ${scope};`)).toBe(0);
    const sent = h.mail.notices.slice(before).filter((n) => n.notice.kind === 'member_removed');
    expect(sent.map((n) => n.to).sort()).toEqual(
      [
        org.ownerEmail,
        await h.sql(`select email from app.users where id = '${second.access.userId}';`),
      ].sort(),
    );
    expect(sent[0]?.notice).toMatchObject({ revokedKeys: 2, membershipId: admin.membership });
  });

  it('takes effect on the next request of the person removed', async () => {
    const org = await newOrg(h);
    const member = await join(org, 'member', 'editor');
    const sessions = h.sessions();
    expect((await sessions.resolveAccess(member.cookie, org.slug)).kind).toBe('ok');
    expect((await h.roles().removeMember(org.owner, member.membership)).ok).toBe(true);
    expect((await sessions.resolveAccess(member.cookie, org.slug)).kind).toBe('not_member');
  });

  it.each<[string, OrgRole]>([
    ['an admin', 'admin'],
    ['an owner', 'owner'],
  ])(
    'demotes %s to member with every key they made and their invitations gone',
    async (_l, role) => {
      const org = await newOrg(h);
      const person = await join(org, role);
      const keys = [await keyOf(person.access)];
      await inviteFrom(person.access, 'member');
      if (role === 'owner') await inviteFrom(person.access, 'owner');
      const before = h.mail.notices.length;
      const result = await h.roles().changeRole(org.owner, person.membership, 'member');
      if (!result.ok) throw result.error;
      expect(result.value).toMatchObject({ from: role, to: 'member', revokedKeyIds: keys });
      expect(result.value.deletedInvitations).toBe(role === 'owner' ? 2 : 1);
      const scope = `organization_id = '${org.organizationId}'`;
      expect(await count(`select count(*) from app.api_keys where ${scope};`)).toBe(0);
      expect(await count(`select count(*) from app.invitations where ${scope};`)).toBe(0);
      const sent = h.mail.notices.slice(before);
      expect(sent.map((n) => [n.to, n.notice.kind])).toEqual([
        [org.ownerEmail, 'member_keys_revoked'],
      ]);
    },
  );

  it('keeps the keys of an owner made admin, and drops only their owner invitations', async () => {
    const org = await newOrg(h);
    const person = await join(org, 'owner');
    await keyOf(person.access);
    await inviteFrom(person.access, 'owner');
    await inviteFrom(person.access, 'admin');
    const result = await h.roles().changeRole(org.owner, person.membership, 'admin');
    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({ revokedKeyIds: [], deletedInvitations: 1 });
    const scope = `organization_id = '${org.organizationId}'`;
    expect(await count(`select count(*) from app.api_keys where ${scope};`)).toBe(1);
    expect(await h.sql(`select string_agg(role, ',') from app.invitations where ${scope};`)).toBe(
      'admin',
    );
  });

  it('tells every owner about a new owner', async () => {
    const org = await newOrg(h);
    const admin = await join(org, 'admin');
    const before = h.mail.notices.length;
    expect((await h.roles().changeRole(org.owner, admin.membership, 'owner')).ok).toBe(true);
    const sent = h.mail.notices.slice(before);
    expect(sent.map((n) => n.notice.kind)).toEqual(['owner_added', 'owner_added']);
  });

  // A key created while its maker is being demoted waits on the membership lock, so it is
  // either revoked by the demotion or refused because the maker is now a member.
  it('never keeps a key made during a demotion of its maker', async () => {
    for (let round = 0; round < 5; round += 1) {
      const org = await newOrg(h);
      const admin = await join(org, 'admin');
      const [made, demoted] = await Promise.all([
        h.apiKeys().createApiKey(admin.access, input()),
        h.roles().changeRole(org.owner, admin.membership, 'member'),
      ]);
      expect(demoted.ok).toBe(true);
      const left = await count(
        `select count(*) from app.api_keys where organization_id = '${org.organizationId}';`,
      );
      expect(left, `round ${String(round)}, key ${made.ok ? 'made' : made.error.code}`).toBe(0);
    }
  });
});

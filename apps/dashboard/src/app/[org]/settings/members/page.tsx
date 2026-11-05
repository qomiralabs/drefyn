import type { Metadata } from 'next';
import { dashboardAuth } from '../../../../server/auth.ts';
import { guardOrganization } from '../../../../server/guard.ts';
import { invitationRows, memberRows } from '../../../../server/settings-views.ts';
import { failureReference } from '../../../../server/sign-in-support.ts';
import { MembersScreen } from '../../../../settings/members.tsx';
import { seatsFrom } from '../../../../settings/models.ts';
import { LoadProblem } from '../../../../settings/parts.tsx';

interface Params {
  params: Promise<{ org: string }>;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  await guardOrganization((await params).org);
  return { title: 'Members' };
}

async function load(guarded: Awaited<ReturnType<typeof guardOrganization>>) {
  const auth = await dashboardAuth();
  const { access } = guarded;
  const list = await auth.members.listMembers(access);
  const manage = access.permissions.includes('org.manage_members');
  const projects = manage ? await auth.members.listProjects(access) : null;
  if (!list.ok || projects?.ok === false) return null;
  try {
    return { list: list.value, seats: await auth.invitations.seatUsage(access), projects };
  } catch {
    return null;
  }
}

export default async function MembersPage({ params }: Params) {
  const { org } = await params;
  const guarded = await guardOrganization(org);
  const { access, view } = guarded;
  const read = await load(guarded);
  if (read === null) {
    return (
      <LoadProblem
        title={`Could not load the members of ${view.organizationName}`}
        reference={failureReference('settings.members_read_failed')}
      >
        Everyone keeps their access. Only this page did not load.
      </LoadProblem>
    );
  }
  return (
    <MembersScreen
      facts={{
        org,
        organization: view.organizationName,
        actorRole: access.role,
        manage: access.permissions.includes('org.manage_members'),
        members: memberRows(read.list),
        invitations: invitationRows(read.list),
        projects:
          read.projects?.ok === true
            ? read.projects.value.map((project) => ({
                id: project.projectId,
                name: project.name,
                product: project.product,
              }))
            : [],
        seats: seatsFrom(read.seats),
        now: new Date().toISOString(),
      }}
    />
  );
}

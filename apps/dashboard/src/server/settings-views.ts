import type { AccountView, ApiKeyPage, MemberList } from '@drefyn/auth';
import type { KeyRow } from '../settings/api-keys.tsx';
import type { InvitationRow, MemberRow } from '../settings/members.tsx';

// Dates as strings, because these cross into client components, and so the page's words
// come out the same on the server and in the browser.

export const memberRows = (list: MemberList): readonly MemberRow[] =>
  list.members.map((member) => ({
    id: member.membershipId,
    name: member.name,
    email: member.email,
    role: member.role,
    defaultProjectRole: member.defaultProjectRole,
    joinedAt: member.joinedAt.toISOString(),
    self: member.self,
    projectRoles: member.projectRoles,
  }));

export const invitationRows = (list: MemberList): readonly InvitationRow[] =>
  list.invitations.map((invitation) => ({
    id: invitation.invitationId,
    email: invitation.email,
    role: invitation.role,
    defaultProjectRole: invitation.defaultProjectRole,
    invitedBy: invitation.invitedBy,
    expiresAt: invitation.expiresAt.toISOString(),
    expired: invitation.expired,
  }));

// revokedAt is left out on purpose: only whether a key is revoked is a fact to show, and the
// state says that. The time is not something this page can vouch for.
export const keyRows = (page: ApiKeyPage): readonly KeyRow[] =>
  page.items.map((key) => ({
    id: key.keyId,
    name: key.name,
    suffix: key.displaySuffix,
    scopes: key.scopes,
    projectScope: key.projectScope,
    projectIds: key.projectIds,
    state: key.state,
    creatorName: key.creatorName,
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    expiresAt: key.expiresAt?.toISOString() ?? null,
  }));

export const identityRows = (account: AccountView) =>
  account.identities.map((identity) => ({
    provider: identity.provider,
    account: identity.account,
    linkedAt: identity.linkedAt.toISOString(),
  }));

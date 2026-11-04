import { normalizeAddress, safeReturnTo, type SessionInfo, type SignUpMode } from '@drefyn/auth';
import { cookies } from 'next/headers';
import { authConfig, dashboardAuth } from './auth.ts';
import { appOrigin } from './origin.ts';

// What the landing rules look at, and nothing more, so each one can be walked in a test.
export interface Arriving {
  readonly organizations: readonly { readonly slug: string }[];
  readonly account: { readonly displayName: string | null };
}

export type FirstRunPage = '/welcome' | '/organizations/new';

export const WELCOME: FirstRunPage = '/welcome';
export const NEW_ORGANIZATION: FirstRunPage = '/organizations/new';

// A saved name is the mark of a finished Welcome. Nothing else writes it, so no new column
// has to agree with it, and an unfinished Welcome simply comes back.
export function landing({ organizations, account }: Arriving): string {
  if (account.displayName === null) return WELCOME;
  const first = organizations[0];
  return first === undefined ? NEW_ORGANIZATION : `/${first.slug}`;
}

// New organizations follow sign up: where people arrive only by invitation, the same people
// do not start tenants of their own. The operator command stays the way to add one.
export const mayCreateOrganization = (signUp: SignUpMode): boolean => signUp === 'open';

// Where a first run page sends this person instead of drawing itself, or null to draw it.
export function instead(page: FirstRunPage, person: Arriving, signUp: SignUpMode): string | null {
  const { organizations, account } = person;
  if (page === WELCOME) return account.displayName === null ? null : '/';
  if (account.displayName === null) return WELCOME;
  const first = organizations[0];
  return mayCreateOrganization(signUp) || first === undefined ? null : `/${first.slug}`;
}

// Where a sign in ends. A return path can point past Welcome, at an organization a new person
// is not in, so Welcome comes first and the path is kept for after it. A failed read is not
// worth a failed sign in: / asks the same question again.
export async function arrival(session: SessionInfo, returnTo: string): Promise<string> {
  const target = safeReturnTo(returnTo, appOrigin());
  if (target === '/') return target;
  const auth = await dashboardAuth();
  const read = await auth.account.readAccount(session);
  if (!read.ok || read.value.displayName !== null) return target;
  return `${WELCOME}?next=${encodeURIComponent(target)}`;
}

export interface HeldInvitation {
  readonly organizationName: string;
  readonly inviterName: string;
}

// The invitation this browser holds for this person. The token is the only way in: no lookup
// by address runs across organizations.
export async function heldInvitation(session: SessionInfo): Promise<HeldInvitation | null> {
  const token = (await cookies()).get(authConfig().cookies.invite)?.value;
  if (token === undefined) return null;
  const auth = await dashboardAuth();
  const read = await auth.invitations.readInvitation(token);
  if (!read.ok || read.value.email !== normalizeAddress(session.email)) return null;
  const { organizationName, inviterName } = read.value;
  return { organizationName, inviterName };
}

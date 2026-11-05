import {
  safeReturnTo,
  type AccessContext,
  type AccessView,
  type AccountView,
  type SessionInfo,
} from '@drefyn/auth';
import type { OrganizationSummary } from '@drefyn/auth';
import { cookies, headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { after, connection } from 'next/server';
import { cache } from 'react';
import { parseShellPath } from '../shell/route.ts';
import { dashboardAuth, sessionCookieName, type DashboardAuth } from './auth.ts';
import { requireDashboard, requireDashboardForVisitor } from './gate.ts';
import { appOrigin, REQUEST_PATH_HEADER } from './origin.ts';

export interface GuardedOrganization {
  readonly access: AccessContext;
  readonly view: AccessView;
}

// The answer for nobody signed in, the same for every slug. Flag off stays a 404.
async function refuseVisitor(): Promise<never> {
  await requireDashboardForVisitor();
  const path = (await headers()).get(REQUEST_PATH_HEADER);
  const next = safeReturnTo(path, appOrigin());
  redirect(`/sign-in?next=${encodeURIComponent(next)}`);
}

interface Credential {
  readonly auth: DashboardAuth;
  readonly cookie: string;
}

// In an outage flag off stays a 404. Flag on rethrows, so the person gets a 500, never a
// redirect that reads as a sign out or a 404 that reads as lost access.
async function orOutage<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    await requireDashboardForVisitor();
    throw error;
  }
}

// No cookie means no database work at all.
async function credential(): Promise<Credential | null> {
  const value = (await cookies()).get(sessionCookieName())?.value;
  if (value === undefined) return null;
  return { auth: await dashboardAuth(), cookie: value };
}

// Next renders a page and its generateMetadata alongside their layouts, so a check in the
// layout alone still streams the page. Every page and every generateMetadata awaits this
// first. Cached per request, so the person is read once however many callers there are.
export const guardOrganization = cache(async (slug: string): Promise<GuardedOrganization> => {
  await connection();
  if (parseShellPath(`/${slug}`) === null) notFound();
  const result = await orOutage(async () => {
    const held = await credential();
    if (held === null) return null;
    return { auth: held.auth, answer: await held.auth.sessions.resolveAccess(held.cookie, slug) };
  });
  if (result === null || result.answer.kind === 'signed_out') return refuseVisitor();
  if (result.answer.kind === 'not_member') notFound();
  const { access, view, touchDue } = result.answer;
  await requireDashboard(access.organizationId, access.userId);
  if (touchDue) {
    const { userId, sessionId, organizationId } = access;
    after(() => result.auth.sessions.touchSession({ userId, sessionId, organizationId }));
  }
  return { access, view };
});

const signedIn = cache(async () => {
  await connection();
  const found = await orOutage(async () => {
    const held = await credential();
    if (held === null) return null;
    const session = await held.auth.sessions.resolveSession(held.cookie);
    return session === null ? null : { auth: held.auth, session };
  });
  return found ?? refuseVisitor();
});

// For account level actions, which also serve a person with no organization yet.
export const guardSession = cache(async (): Promise<SessionInfo> => {
  const { session } = await signedIn();
  await requireDashboardForVisitor();
  return session;
});

// For pages with no organization in the URL. The shell needs one to draw, so it is the
// person's first; someone with none gets a null home and a page that needs none.
export const guardAccountHome = cache(
  async (): Promise<{
    readonly session: SessionInfo;
    readonly organizations: readonly OrganizationSummary[];
    readonly home: GuardedOrganization | null;
  }> => {
    const { auth, session } = await signedIn();
    await requireDashboardForVisitor();
    const organizations = await orOutage(() => auth.organizations.listMyOrganizations(session));
    const first = organizations[0];
    const home = first === undefined ? null : await guardOrganization(first.slug);
    return { session, organizations, home };
  },
);

export interface SignedInPerson {
  readonly session: SessionInfo;
  readonly organizations: readonly OrganizationSummary[];
  readonly account: AccountView;
}

// For / and the first run pages, the pages for someone who may belong to nothing yet. The
// flag is asked about the first organization, the one / lands on, or about nobody when there
// is none. Flag first, so a dashboard that is off reads no account.
export const guardSignedIn = cache(async (): Promise<SignedInPerson> => {
  const { auth, session } = await signedIn();
  const organizations = await orOutage(() => auth.organizations.listMyOrganizations(session));
  const first = organizations[0];
  if (first === undefined) await requireDashboardForVisitor();
  else await requireDashboard(first.organizationId, session.userId);
  const read = await auth.account.readAccount(session);
  if (!read.ok) throw read.error;
  return { session, organizations, account: read.value };
});

// Who a signed out page is talking to, for the pages that change with it. An outage reads as
// nobody, so the page still offers its form.
export const currentSession = cache(async (): Promise<SessionInfo | null> => {
  try {
    const held = await credential();
    return held === null ? null : await held.auth.sessions.resolveSession(held.cookie);
  } catch {
    return null;
  }
});

// For pages that hold no data. The walker keeps an exact list of them.
export const guardPublic = cache(async (): Promise<void> => {
  await connection();
  await requireDashboardForVisitor();
});

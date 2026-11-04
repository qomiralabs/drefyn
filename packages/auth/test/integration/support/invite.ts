import { randomBytes } from 'node:crypto';
import type {
  AccessContext,
  AuthConfig,
  CookieSpec,
  Invitations,
  OrgRole,
  RateLimiter,
} from '../../../src/index.ts';
import type { Browser } from './email.ts';
import type { Harness } from './harness.ts';

// The caps are proved in their own cases; here they stay out of the way.
export const unlimited: RateLimiter = {
  keyFor: () => Buffer.alloc(32),
  reserve: () => Promise.resolve(),
};

export const freshAddress = (label = 'p') =>
  `${label}${randomBytes(5).toString('hex')}@example.com`;

const sessionCookie = (h: Harness, cookies: readonly CookieSpec[]) =>
  cookies.find((c) => c.name === h.config.cookies.session && c.maxAgeSeconds > 0)?.value ?? '';

// An organization with an owner who can invite, made the way the product makes it.
export async function invitingOrganization(h: Harness) {
  const email = freshAddress('owner');
  const user = await h.user(email);
  const browser = { ip: '203.0.113.9', userAgent: 'Integration/1.0', cookies: new Map() };
  const started = await h.sessions().startSession(browser, { userId: user, method: 'email' });
  const made = await h.organizations({ limiter: unlimited }).createOrganization(started.session, {
    name: 'Sign Up Co',
  });
  if (!made.ok) throw made.error;
  const { access, slug } = made.value;
  const resolved = await h.sessions().resolveAccess(sessionCookie(h, started.setCookies), slug);
  if (resolved.kind !== 'ok') throw new Error(`no access: ${resolved.kind}`);
  return { organizationId: access.organizationId, access: resolved.access };
}

// Invites the address and returns the token and block token the mail carried.
export async function inviteAddress(
  h: Harness,
  invitations: Invitations,
  access: AccessContext,
  email: string,
  role: OrgRole = 'member',
) {
  const result = await invitations.invite(access, { email, role, defaultProjectRole: null });
  if (!result.ok) throw result.error;
  if (result.value.kind !== 'sent') throw new Error('blocked');
  await result.value.send();
  const mail = h.invitationMail.filter((m) => m.to === email).at(-1);
  if (mail === undefined) throw new Error('no invitation mail');
  return {
    invitationId: mail.invitation.invitationId,
    token: mail.invitation.link.hash.slice(1),
    blockToken: mail.invitation.blockLink.hash.slice(1),
  };
}

export function invitationsFor(h: Harness, config: AuthConfig) {
  return h.invitations({ limiter: unlimited }, config);
}

// What the invite page does for a signed out person: hand the token to auth and keep the
// cookie it answers with.
export function hold(invitations: Invitations, browser: Browser, token: string): void {
  const held = invitations.holdInvitation(browser.context(), token);
  if (!held.ok) throw held.error;
  browser.apply(held.value.setCookies);
}

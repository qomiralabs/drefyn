import { randomBytes } from 'node:crypto';
import { limitFor } from '@drefyn/entitlements';
import { beforeAll, expect, it } from 'vitest';
import {
  parseAuthConfig,
  type AccessContext,
  type CookieSpec,
  type InvitationSend,
  type OrgRole,
  type RateLimiter,
  type SessionInfo,
} from '../../src/index.ts';
import { BLOCK_KEY, validEnv } from '../support.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';

const fresh = harness();
let h: Harness;

// The caps are proved in their own cases; everywhere else they stay out of the way.
const unlimited: RateLimiter = { keyFor: () => Buffer.alloc(32), reserve: () => Promise.resolve() };

const browser = () => ({
  ip: '203.0.113.9',
  userAgent: 'Integration/1.0',
  cookies: new Map<string, string>(),
});

const address = (label = 'p') => `${label}${randomBytes(5).toString('hex')}@example.com`;

const cookieOf = (cookies: readonly CookieSpec[]) =>
  cookies.find((c) => c.name === h.config.cookies.session && c.maxAgeSeconds > 0)?.value ?? '';

async function person(email = address()) {
  const user = await h.user(email);
  const started = await h.sessions().startSession(browser(), { userId: user, method: 'email' });
  return { user, email, session: started.session, cookie: cookieOf(started.setCookies) };
}

async function organization(tier = 'self_hosted') {
  const owner = await person();
  const slug = `inv-${randomBytes(5).toString('hex')}`;
  const made = await h.organizations({ limiter: unlimited }).createOrganization(owner.session, {
    name: 'Invite Co',
    slug,
  });
  if (!made.ok) throw made.error;
  const org = made.value.organizationId;
  if (tier !== 'self_hosted') await setTier(org, tier);
  return { owner, org, slug, access: made.value };
}

const setTier = (org: string, tier: string) =>
  h.sql(`update app.organizations set plan_tier = '${tier}' where organization_id = '${org}';`);

async function accessFor(cookie: string, slug: string): Promise<AccessContext> {
  const result = await h.sessions().resolveAccess(cookie, slug);
  if (result.kind !== 'ok') throw new Error(`no access: ${result.kind}`);
  return result.access;
}

const lastMailTo = (to: string): InvitationSend => {
  const found = h.invitationMail.filter((m) => m.to === to).at(-1);
  if (found === undefined) throw new Error('no mail');
  return found.invitation;
};

async function invited(a: AccessContext, email: string, role: OrgRole = 'member') {
  const result = await h
    .invitations({ limiter: unlimited })
    .invite(a, { email, role, defaultProjectRole: null });
  if (!result.ok) throw result.error;
  if (result.value.kind !== 'sent') throw new Error('blocked');
  await result.value.send();
  return { token: lastMailTo(email).link.hash.slice(1), mail: lastMailTo(email) };
}

const count = (table: string, where: string) =>
  h.sql(`select count(*) from app.${table} where ${where};`);

const seats = async (a: AccessContext) => (await h.invitations().seatUsage(a)).used;

describeWithStack('invitations against Postgres', () => {
  beforeAll(async () => {
    h = await fresh();
  });

  it('never passes a limit of 5 with 20 parallel invites', async () => {
    const { org, access } = await organization('starter');
    expect(limitFor('starter', 'org.seats')).toBe(5);
    const invitations = h.invitations({ limiter: unlimited });
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        invitations.invite(access, { email: address(), role: 'member', defaultProjectRole: null }),
      ),
    );
    const sent = results.filter((r) => r.ok && r.value.kind === 'sent');
    const refused = results.flatMap((r) => (r.ok ? [] : [r.error.code]));
    // The owner holds one seat, so four invitations fit.
    expect(sent).toHaveLength(4);
    expect(refused).toEqual(Array.from({ length: 16 }, () => 'AUTH_SEAT_LIMIT'));
    expect(await seats(access)).toBe(5);
    expect(await count('invitations', `organization_id = '${org}'`)).toBe('4');
  });

  it('stops counting an expired invitation and lets the seat be used again', async () => {
    const { org, access } = await organization('free');
    const free = Number(limitFor('free', 'org.seats'));
    const first = address();
    await invited(access, first);
    expect(await seats(access)).toBe(2);
    const refused = await h
      .invitations({ limiter: unlimited })
      .invite(access, { email: address(), role: 'member', defaultProjectRole: null });
    expect(free).toBe(2);
    expect(refused.ok ? null : refused.error.code).toBe('AUTH_SEAT_LIMIT');
    await h.sql(
      `update app.invitations set expires_at = now() - interval '1 second' where organization_id = '${org}';`,
    );
    expect(await seats(access)).toBe(1);
    await invited(access, address());
    expect(await seats(access)).toBe(2);
  });

  it('refuses an invite to an address that already belongs to a member', async () => {
    const { owner, access } = await organization();
    const result = await h.invitations({ limiter: unlimited }).invite(access, {
      email: owner.email.toUpperCase(),
      role: 'member',
      defaultProjectRole: null,
    });
    expect(result.ok ? null : result.error.code).toBe('AUTH_ALREADY_MEMBER');
  });

  it('keeps everyone after a downgrade and refuses invites until the count fits', async () => {
    const { org, access } = await organization('starter');
    const people = [await person(), await person(), await person()];
    for (const p of people) {
      const { token } = await invited(access, p.email);
      const accepted = await h.invitations().acceptInvitation(p.session, token);
      if (!accepted.ok) throw accepted.error;
    }
    expect(await seats(access)).toBe(4);
    await setTier(org, 'free');
    // Nobody is removed and nothing is deleted.
    expect(await count('memberships', `organization_id = '${org}'`)).toBe('4');
    expect(await seats(access)).toBe(4);
    const refused = await h
      .invitations({ limiter: unlimited })
      .invite(access, { email: address(), role: 'member', defaultProjectRole: null });
    expect(refused.ok ? null : refused.error.code).toBe('AUTH_SEAT_LIMIT');
    // Removing members is its own flow; the superuser stands in so the count fits.
    await h.sql(
      `delete from app.memberships where organization_id = '${org}' and role <> 'owner';`,
    );
    await invited(access, address());
    expect(await seats(access)).toBe(2);
  });

  it('lets the invited address accept once, as the role invited, and deletes the invitation', async () => {
    const { org, access } = await organization();
    const admin = await person();
    const { token } = await invited(access, admin.email, 'admin');
    const accepted = await h.invitations().acceptInvitation(admin.session, token);
    if (!accepted.ok) throw accepted.error;
    expect(accepted.value.access.role).toBe('admin');
    expect(accepted.value.access.organizationId).toBe(org);
    expect(
      await h.sql(
        `select role || '|' || coalesce(invitation_id::text, 'none') from app.memberships
          where organization_id = '${org}' and user_id = '${admin.user}';`,
      ),
    ).toBe('admin|none');
    expect(await count('invitations', `organization_id = '${org}'`)).toBe('0');
    const again = await h.invitations().acceptInvitation(admin.session, token);
    expect(again.ok ? null : again.error.code).toBe('AUTH_INVITATION_INVALID');
  });

  it('refuses acceptance by another address', async () => {
    const { org, access } = await organization();
    const { token } = await invited(access, address());
    const stranger = await person();
    const result = await h.invitations().acceptInvitation(stranger.session, token);
    expect(result.ok ? null : result.error.code).toBe('AUTH_INVITATION_EMAIL_MISMATCH');
    expect(await count('memberships', `organization_id = '${org}'`)).toBe('1');
  });

  it('refuses acceptance once the inviter was removed or demoted', async () => {
    const { org, access, slug } = await organization();
    const inviter = await person();
    const promoted = await invited(access, inviter.email, 'admin');
    const joined = await h.invitations().acceptInvitation(inviter.session, promoted.token);
    if (!joined.ok) throw joined.error;
    const inviterAccess = await accessFor(inviter.cookie, slug);

    const demotedCase = await person();
    const fromDemoted = await invited(inviterAccess, demotedCase.email, 'member');
    // Role changes are their own flow; the superuser stands in for a demotion.
    await h.sql(
      `update app.memberships set role = 'member' where organization_id = '${org}' and user_id = '${inviter.user}';`,
    );
    const demoted = await h.invitations().acceptInvitation(demotedCase.session, fromDemoted.token);
    expect(demoted.ok ? null : demoted.error.code).toBe('AUTH_INVITATION_INVALID');

    await h.sql(
      `update app.memberships set role = 'admin' where organization_id = '${org}' and user_id = '${inviter.user}';`,
    );
    const removedCase = await person();
    const fromRemoved = await invited(inviterAccess, removedCase.email, 'member');
    await h.sql(
      `delete from app.memberships where organization_id = '${org}' and user_id = '${inviter.user}';`,
    );
    expect(await count('invitations', `organization_id = '${org}'`)).toBe('0');
    const removed = await h.invitations().acceptInvitation(removedCase.session, fromRemoved.token);
    expect(removed.ok ? null : removed.error.code).toBe('AUTH_INVITATION_INVALID');
  });

  it('refuses an expired invitation and a wrong secret, writing nothing', async () => {
    const { org, access } = await organization();
    const guest = await person();
    const { token } = await invited(access, guest.email);
    const wrong = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;
    const bad = await h.invitations().acceptInvitation(guest.session, wrong);
    expect(bad.ok ? null : bad.error.code).toBe('AUTH_INVITATION_INVALID');
    await h.sql(
      `update app.invitations set expires_at = now() - interval '1 second' where organization_id = '${org}';`,
    );
    const late = await h.invitations().acceptInvitation(guest.session, token);
    expect(late.ok ? null : late.error.code).toBe('AUTH_INVITATION_INVALID');
    expect(await count('memberships', `organization_id = '${org}'`)).toBe('1');
    expect(await count('invitations', `organization_id = '${org}'`)).toBe('1');
  });

  it('mails every invite with a block link on the app origin', async () => {
    const { org, access } = await organization();
    const to = address();
    const { mail } = await invited(access, to);
    expect(mail.organizationId).toBe(org);
    expect(mail.link.origin).toBe(h.config.appOrigin);
    expect(mail.blockLink.origin).toBe(h.config.appOrigin);
    expect(mail.blockLink.pathname).toBe('/invite/block');
    expect(mail.blockLink.search).toBe('');
    expect(mail.blockLink.hash.length).toBeGreaterThan(100);
    // A resend replaces the secret and counts the send.
    const again = await invited(access, to);
    expect(again.mail.sendCount).toBe(2);
    expect(again.mail.invitationId).toBe(mail.invitationId);
    expect(again.token).not.toBe(mail.link.hash.slice(1));
    expect(await seats(access)).toBe(2);
  });

  it.each([
    ['DREFYN_AUTH_RATE_INVITE_SEND', 'organization'],
    ['DREFYN_AUTH_RATE_INVITE_SEND_USER', 'inviter'],
    ['DREFYN_AUTH_RATE_INVITE_RECIPIENT', 'recipient'],
  ])('refuses the next invite once the %s cap is full (per %s)', async (key, per) => {
    const capped = parseAuthConfig({
      ...validEnv(randomBytes(32).toString('base64url')),
      [key]: '2/1h',
    });
    const { access } = await organization();
    const invitations = h.invitations({}, capped);
    const recipient = address();
    const send = (email: string) =>
      invitations.invite(access, { email, role: 'member', defaultProjectRole: null });
    const first = per === 'recipient' ? recipient : address();
    const second = per === 'recipient' ? recipient : address();
    expect((await send(first)).ok).toBe(true);
    expect((await send(second)).ok).toBe(true);
    const third = await send(per === 'recipient' ? recipient : address());
    expect(third.ok ? null : third.error.code).toBe('AUTH_RATE_LIMITED');
    if (per === 'recipient') {
      // The recipient cap holds across organizations.
      const other = await organization();
      const elsewhere = await h
        .invitations({}, capped)
        .invite(other.access, { email: recipient, role: 'member', defaultProjectRole: null });
      expect(elsewhere.ok ? null : elsewhere.error.code).toBe('AUTH_RATE_LIMITED');
    }
  });

  it('never blocks on a read of the block page; only blockInvitation does, once', async () => {
    const { org, access } = await organization();
    const to = address();
    const { mail } = await invited(access, to);
    const blockToken = mail.blockLink.hash.slice(1);
    for (let i = 0; i < 3; i += 1) {
      const read = await h.invitations().readInvitationBlock(blockToken);
      if (!read.ok) throw read.error;
      expect(read.value.organizationName).toBe('Invite Co');
    }
    expect(await count('invitation_blocks', `organization_id = '${org}'`)).toBe('0');
    expect(await count('invitations', `organization_id = '${org}'`)).toBe('1');
    expect((await h.invitations().blockInvitation(blockToken)).ok).toBe(true);
    expect((await h.invitations().blockInvitation(blockToken)).ok).toBe(true);
    expect(await count('invitation_blocks', `organization_id = '${org}'`)).toBe('1');
    // The pending invitation goes with the block, so its seat is free again.
    expect(await count('invitations', `organization_id = '${org}'`)).toBe('0');
    const blocked = await h
      .invitations({ limiter: unlimited })
      .invite(access, { email: to, role: 'member', defaultProjectRole: null });
    expect(blocked).toEqual({ ok: true, value: { kind: 'blocked' } });
    expect(await count('invitations', `organization_id = '${org}'`)).toBe('0');
    expect(await seats(access)).toBe(1);
  });

  it('keeps a block matching after DREFYN_AUTH_SECRET is rotated', async () => {
    const { org, access } = await organization();
    const to = address();
    const { mail } = await invited(access, to);
    expect((await h.invitations().blockInvitation(mail.blockLink.hash.slice(1))).ok).toBe(true);
    const rotated = parseAuthConfig({
      ...validEnv(randomBytes(32).toString('base64url')),
      DREFYN_AUTH_INVITATION_BLOCK_KEY: BLOCK_KEY,
    });
    const result = await h
      .invitations({ limiter: unlimited }, rotated)
      .invite(access, { email: to, role: 'member', defaultProjectRole: null });
    expect(result).toEqual({ ok: true, value: { kind: 'blocked' } });
    expect(await count('invitations', `organization_id = '${org}'`)).toBe('0');
    expect(await seats(access)).toBe(1);
  });

  it('accepts a session whose address differs only in case', async () => {
    const { access } = await organization();
    const guest = await person();
    const { token } = await invited(access, guest.email);
    const shouting: SessionInfo = { ...guest.session, email: guest.email.toUpperCase() };
    expect((await h.invitations().acceptInvitation(shouting, token)).ok).toBe(true);
  });

  it('refuses an owner invitation from a stale or missing sign in, and leaves others alone', async () => {
    const { org, access } = await organization();
    const email = address();
    const age = (minutes: number) =>
      h.sql(
        `update app.sessions set authenticated_at = now() - interval '${String(minutes)} minutes'
          where id = '${access.sessionId}';`,
      );
    const invite = (role: OrgRole) =>
      h
        .invitations({ limiter: unlimited })
        .invite(access, { email, role, defaultProjectRole: null });
    await age(16);
    const stale = await invite('owner');
    expect(stale.ok ? 'ok' : stale.error.code).toBe('AUTH_RECENT_AUTH_REQUIRED');
    expect(await count('invitations', `organization_id = '${org}'`)).toBe('0');
    expect((await invite('member')).ok).toBe(true);
    await age(14);
    expect((await invite('owner')).ok).toBe(true);
    await h.sql(`delete from app.sessions where id = '${access.sessionId}';`);
    const gone = await invite('owner');
    expect(gone.ok ? 'ok' : gone.error.code).toBe('AUTH_SESSION_INVALID');
  });

  it('tells every existing owner when an owner invitation is accepted, past a failed send', async () => {
    const { owner, access } = await organization();
    const second = await person();
    const first = await invited(access, second.email, 'owner');
    const joined = await h.invitations().acceptInvitation(second.session, first.token);
    if (!joined.ok) throw joined.error;
    const third = await person();
    const { token } = await invited(access, third.email, 'owner');
    const before = h.mail.notices.length;
    h.mail.failNext();
    const accepted = await h.invitations().acceptInvitation(third.session, token);
    expect(accepted.ok).toBe(true);
    const sent = h.mail.notices.slice(before);
    expect(sent.map((n) => n.notice.kind)).toEqual(['owner_added']);
    expect([owner.email, second.email]).toContain(sent[0]?.to);
    expect(sent.map((n) => n.to)).not.toContain(third.email);
  });

  it('names a new owner by address when their stored name reads as a link', async () => {
    const { owner, access } = await organization();
    const newcomer = await person();
    await h.sql(
      `update app.users set display_name = 'Acme Security http://evil.example/login'
        where id = '${newcomer.user}';`,
    );
    const { token } = await invited(access, newcomer.email, 'owner');
    const before = h.mail.notices.length;
    const accepted = await h.invitations().acceptInvitation(newcomer.session, token);
    expect(accepted.ok).toBe(true);
    const sent = h.mail.notices.slice(before);
    expect(sent.map((n) => n.to)).toEqual([owner.email]);
    expect(sent[0]?.notice).toMatchObject({ kind: 'owner_added', memberName: newcomer.email });
  });

  it('tells nobody when a member accepts', async () => {
    const { access } = await organization();
    const member = await person();
    const { token } = await invited(access, member.email, 'member');
    const before = h.mail.notices.length;
    expect((await h.invitations().acceptInvitation(member.session, token)).ok).toBe(true);
    expect(h.mail.notices.length).toBe(before);
  });
});

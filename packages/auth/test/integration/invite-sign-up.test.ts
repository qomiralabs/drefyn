import { closeDatabase, createDatabase, parseDatabaseConfig, type Database } from '@drefyn/db';
import { beforeAll, expect, it } from 'vitest';
import {
  formatInvitationToken,
  parseInvitationToken,
  type AuthConfig,
  type Invitations,
} from '../../src/index.ts';
import {
  configWith,
  expectSameWire,
  flowFor,
  newBrowser,
  requestCode,
  wireOf,
  type Browser,
  type Flow,
} from './support/email.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';
import {
  freshAddress,
  hold,
  inviteAddress,
  invitationsFor,
  invitingOrganization,
  unlimited,
} from './support/invite.ts';
import { urlFor } from './support/stack.ts';

const fresh = harness();
let h: Harness;
let config: AuthConfig;
let invitations: Invitations;
let flow: Flow;

const usersNamed = (email: string) =>
  h.sql(`select count(*) from app.users where email_normalized = '${email}';`);

// What any address without an account gets in invite_only: a browser with no invitation.
async function strangerWire() {
  const b = newBrowser();
  return wireOf(await flow.signIn.startEmailSignIn(b.context(), { email: freshAddress('x') }));
}

// Starts from a browser that holds the token, and proves nothing new was let in: the same
// answer as a stranger, no mail and no user.
async function expectRefusedLikeAStranger(b: Browser, email: string) {
  const before = flow.mail.calls.length;
  const result = await flow.signIn.startEmailSignIn(b.context(), { email });
  if (result.ok) await result.value.send();
  expectSameWire(wireOf(result), await strangerWire());
  expect(flow.mail.calls.slice(before).filter((m) => m.to === email)).toHaveLength(0);
  expect(await usersNamed(email)).toBe('0');
}

describeWithStack('invite_only sign up by the invitation this browser holds', () => {
  beforeAll(async () => {
    h = await fresh();
    config = configWith({ DREFYN_AUTH_SIGNUP: 'invite_only' });
    invitations = invitationsFor(h, config);
    flow = flowFor(h, config, { invitations });
  });

  it('creates the user when the cookie holds a live invitation for exactly that address', async () => {
    const { access } = await invitingOrganization(h);
    const email = freshAddress('match');
    const { token } = await inviteAddress(h, invitations, access, email);
    const b = newBrowser();
    hold(invitations, b, token);
    expect(b.cookies.get(config.cookies.invite)).toBe(token);
    const mail = await requestCode(flow, b, email);
    if (mail === null) throw new Error('an invited newcomer holding the link gets mail');
    const result = await flow.signIn.verifyEmailCode(b.context(), mail);
    expect(result.ok).toBe(true);
    expect(await usersNamed(email)).toBe('1');
  });

  it('lets nobody in with a token for another address', async () => {
    const { access } = await invitingOrganization(h);
    const { token } = await inviteAddress(h, invitations, access, freshAddress('invited'));
    const b = newBrowser();
    hold(invitations, b, token);
    await expectRefusedLikeAStranger(b, freshAddress('other'));
  });

  it('lets nobody in with an expired invitation', async () => {
    const { access, organizationId } = await invitingOrganization(h);
    const email = freshAddress('expired');
    const { token, invitationId } = await inviteAddress(h, invitations, access, email);
    await h.sql(
      `update app.invitations set expires_at = now() - interval '1 second'
        where organization_id = '${organizationId}' and id = '${invitationId}';`,
    );
    const b = newBrowser();
    hold(invitations, b, token);
    await expectRefusedLikeAStranger(b, email);
  });

  it('lets nobody in with a revoked invitation', async () => {
    const { access, organizationId } = await invitingOrganization(h);
    const email = freshAddress('revoked');
    const { token, invitationId } = await inviteAddress(h, invitations, access, email);
    // Revoking is its own flow; the superuser stands in for it.
    await h.sql(
      `delete from app.invitations where organization_id = '${organizationId}' and id = '${invitationId}';`,
    );
    const b = newBrowser();
    hold(invitations, b, token);
    await expectRefusedLikeAStranger(b, email);
  });

  it('lets nobody in with a blocked invitation', async () => {
    const { access } = await invitingOrganization(h);
    const email = freshAddress('blocked');
    const { token, blockToken } = await inviteAddress(h, invitations, access, email);
    expect((await invitations.blockInvitation(blockToken)).ok).toBe(true);
    const b = newBrowser();
    hold(invitations, b, token);
    await expectRefusedLikeAStranger(b, email);
  });

  it('lets nobody new in with an invitation already accepted', async () => {
    const { access } = await invitingOrganization(h);
    const email = freshAddress('accepted');
    const { token } = await inviteAddress(h, invitations, access, email);
    const b = newBrowser();
    hold(invitations, b, token);
    const mail = await requestCode(flow, b, email);
    if (mail === null) throw new Error('no mail');
    const signedIn = await flow.signIn.verifyEmailCode(b.context(), mail);
    if (!signedIn.ok) throw signedIn.error;
    const accepted = await invitations.acceptInvitation(signedIn.value.session, token);
    if (!accepted.ok) throw accepted.error;
    // Acceptance clears the cookie, and the token no longer names a live invitation.
    b.apply(accepted.value.setCookies);
    expect(b.cookies.has(config.cookies.invite)).toBe(false);
    expect(await invitations.allowsSignUp(token, email)).toBe(false);
    const other = newBrowser();
    hold(invitations, other, token);
    await expectRefusedLikeAStranger(other, freshAddress('late'));
  });

  it('lets nobody in with a wrong secret', async () => {
    const { access } = await invitingOrganization(h);
    const email = freshAddress('secret');
    const { token } = await inviteAddress(h, invitations, access, email);
    const parsed = parseInvitationToken(token);
    if (parsed === null) throw new Error('the mail token does not parse');
    const wrong = formatInvitationToken({ ...parsed, secret: Buffer.alloc(32, 1) });
    const b = newBrowser();
    hold(invitations, b, wrong);
    await expectRefusedLikeAStranger(b, email);
  });

  it('lets nobody in with an invitation id from another organization', async () => {
    const home = await invitingOrganization(h);
    const elsewhere = await invitingOrganization(h);
    const email = freshAddress('crossed');
    const { token } = await inviteAddress(h, invitations, elsewhere.access, email);
    const parsed = parseInvitationToken(token);
    if (parsed === null) throw new Error('the mail token does not parse');
    // The real id and secret, but filed under an organization that does not own them.
    const crossed = formatInvitationToken({ ...parsed, organizationId: home.organizationId });
    const b = newBrowser();
    hold(invitations, b, crossed);
    await expectRefusedLikeAStranger(b, email);
  });

  it('creates no user when the invitation is revoked between start and verify', async () => {
    const { access, organizationId } = await invitingOrganization(h);
    const email = freshAddress('between');
    const { token, invitationId } = await inviteAddress(h, invitations, access, email);
    const b = newBrowser();
    hold(invitations, b, token);
    const mail = await requestCode(flow, b, email);
    if (mail === null) throw new Error('no mail');
    await h.sql(
      `delete from app.invitations where organization_id = '${organizationId}' and id = '${invitationId}';`,
    );
    const result = await flow.signIn.verifyEmailCode(b.context(), mail);
    expect(!result.ok && result.error.code).toBe('AUTH_SIGNUP_CLOSED');
    expect(await usersNamed(email)).toBe('0');
  });

  it('creates no second user when the invitation is accepted between start and verify', async () => {
    const { access } = await invitingOrganization(h);
    const email = freshAddress('raced');
    const { token } = await inviteAddress(h, invitations, access, email);
    const first = newBrowser();
    const second = newBrowser();
    hold(invitations, first, token);
    hold(invitations, second, token);
    const firstMail = await requestCode(flow, first, email);
    const secondMail = await requestCode(flow, second, email);
    if (firstMail === null || secondMail === null) throw new Error('no mail');
    const winner = await flow.signIn.verifyEmailCode(second.context(), secondMail);
    if (!winner.ok) throw winner.error;
    const accepted = await invitations.acceptInvitation(winner.value.session, token);
    expect(accepted.ok).toBe(true);
    const late = await flow.signIn.verifyEmailCode(first.context(), firstMail);
    // The address is a person now, so the late browser signs in to them; nobody new is made.
    expect(late.ok && late.value.session.userId).toBe(winner.value.session.userId);
    expect(await usersNamed(email)).toBe('1');
  });

  it('answers as for any address and logs only the organization when the database is down', async () => {
    const { access } = await invitingOrganization(h);
    const email = freshAddress('down');
    const { token, blockToken } = await inviteAddress(h, invitations, access, email);
    const down: Database = await createDatabase(
      parseDatabaseConfig({
        DREFYN_DATABASE_URL: urlFor('app', h.name),
        DREFYN_DATABASE_SSL: 'disable',
        DREFYN_DATABASE_POOL_MAX: '1',
        DREFYN_DATABASE_POOL_WAIT_MS: '1000',
      }),
    );
    await closeDatabase(down);
    const offline = flowFor(h, config, {
      invitations: h.invitations({ db: down, limiter: unlimited }, config),
    });
    const b = newBrowser();
    hold(invitations, b, token);
    const before = h.logs.length;
    const result = await offline.signIn.startEmailSignIn(b.context(), { email });
    if (result.ok) await result.value.send();
    expectSameWire(wireOf(result), await strangerWire());
    expect(offline.mail.calls.filter((m) => m.to === email)).toHaveLength(0);
    expect(await usersNamed(email)).toBe('0');
    const lines = h.logs.slice(before);
    expect(lines.filter((l) => l.event === 'auth.invitation_check_failed')).toEqual([
      {
        level: 'warn',
        event: 'auth.invitation_check_failed',
        fields: { organizationId: `org_${token.slice(0, 26)}` },
      },
    ]);
    const text = JSON.stringify(lines);
    for (const value of [token, blockToken, email, token.slice(-52)]) {
      expect(text).not.toContain(value);
    }
  });
});

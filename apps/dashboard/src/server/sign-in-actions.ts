'use server';
import {
  lastMethodCookie,
  normalizeAddress,
  parseVerifyFragment,
  formatChallengeId,
  type AuthError,
} from '@drefyn/auth';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { after } from 'next/server';
import { noticeFor } from '../auth/outcomes.ts';
import type {
  BlockState,
  CliState,
  InviteState,
  LinkState,
  PasswordState,
  ResetState,
  StartState,
  TypedCodeState,
} from '../auth/states.ts';
import { publicAction, signedInAction } from './actions.ts';
import { authConfig, dashboardAuth } from './auth.ts';
import { currentSession } from './guard.ts';
import { applyCookies, failureReference, finishSignIn } from './sign-in-support.ts';

const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

const noticeOf = (error: AuthError, event: string) =>
  noticeFor(error, error.code === 'AUTH_RATE_LIMITED' ? '' : failureReference(event));

export const startEmail = publicAction(async ({ browser }, form): Promise<StartState> => {
  const email = text(form, 'email');
  if (normalizeAddress(email) === null) return { invalid: true, email };
  const next = text(form, 'next');
  const auth = await dashboardAuth();
  const started = await auth.emailSignIn.startEmailSignIn(browser, {
    email,
    ...(next === '' ? {} : { returnTo: next }),
  });
  if (!started.ok) return { notice: noticeOf(started.error, 'auth.email_start_failed'), email };
  await applyCookies(started.value.setCookies);
  after(started.value.send);
  redirect(text(form, 'from') === 'sign-up' ? '/sign-in/verify?from=sign-up' : '/sign-in/verify');
});

export const verifyCode = publicAction(async ({ browser }, form): Promise<TypedCodeState> => {
  const code = text(form, 'code');
  const auth = await dashboardAuth();
  const done = await auth.emailSignIn.verifyEmailCode(browser, { code });
  if (done.ok) return finishSignIn(done.value);
  switch (done.error.code) {
    case 'AUTH_CODE_INVALID':
      return { problem: 'wrong', code };
    case 'AUTH_CHALLENGE_EXPIRED':
    case 'AUTH_CHALLENGE_BINDING':
      return { problem: 'expired' };
    case 'AUTH_SIGNUP_CLOSED':
      return { problem: 'closed' };
    default:
      return { notice: noticeOf(done.error, 'auth.email_verify_failed'), code };
  }
});

// Opening a link only reads: nothing is proved until the person presses Continue.
export const inspectLink = publicAction(async ({ browser }, form): Promise<LinkState> => {
  const fragment = parseVerifyFragment(text(form, 'fragment'));
  if (fragment === null) return { kind: 'gone' };
  const challenge = formatChallengeId(fragment.challengeId);
  const auth = await dashboardAuth();
  const read = await auth.emailSignIn.readChallenge(browser, { challenge });
  if (!read.ok) return { kind: 'failed', notice: noticeOf(read.error, 'auth.link_read_failed') };
  if (read.value.kind === 'gone') return { kind: 'gone' };
  if (read.value.kind === 'elsewhere') return { kind: 'elsewhere', code: fragment.code };
  return {
    kind: 'here',
    email: read.value.email,
    purpose: read.value.purpose,
    challenge,
    code: fragment.code,
  };
});

export const finishLink = publicAction(async ({ browser }, form): Promise<LinkState> => {
  const challenge = text(form, 'challenge');
  const code = text(form, 'code');
  const auth = await dashboardAuth();
  const done = await auth.emailSignIn.verifyLinkCode(browser, await currentSession(), {
    challenge,
    code,
  });
  if (!done.ok) {
    if (done.error.code === 'AUTH_CHALLENGE_BINDING') return { kind: 'elsewhere', code };
    if (done.error.code === 'AUTH_RATE_LIMITED' || done.error.code === 'AUTH_UNAVAILABLE') {
      return { kind: 'failed', notice: noticeOf(done.error, 'auth.link_finish_failed') };
    }
    return { kind: 'gone' };
  }
  const { value } = done;
  if (value.kind === 'signed_in') return finishSignIn(value.signedIn);
  if (value.kind === 'choose_password') return { kind: 'choose', challenge, code };
  if (value.kind === 'email_changed') after(value.send);
  redirect('/');
});

export const signInPassword = publicAction(async ({ browser }, form): Promise<PasswordState> => {
  const email = text(form, 'email');
  const next = text(form, 'next');
  const auth = await dashboardAuth();
  const done = await auth.passwordSignIn.signInWithPassword(browser, {
    email,
    password: text(form, 'password'),
    csrf: text(form, 'csrf'),
    ...(next === '' ? {} : { returnTo: next }),
  });
  if (done.ok) return finishSignIn(done.value);
  if (done.error.code === 'AUTH_CREDENTIALS_INVALID' || done.error.code === 'AUTH_INPUT_INVALID') {
    return { wrong: true, email };
  }
  return { notice: noticeOf(done.error, 'auth.password_failed'), email };
});

// One form that moves through its steps, so each works with scripts off: the state carries
// the step, and the code stays in a hidden field until the password is saved with it.
export const resetStep = publicAction(async ({ browser }, form): Promise<ResetState> => {
  const step = text(form, 'step');
  const auth = await dashboardAuth();
  if (step === 'ask') {
    const email = text(form, 'email');
    if (normalizeAddress(email) === null) return { step: 'ask', invalid: true, email };
    const started = await auth.passwordAccount.startPasswordReset(browser, { email });
    if (!started.ok) {
      return { step: 'ask', email, notice: noticeOf(started.error, 'auth.reset_start_failed') };
    }
    await applyCookies(started.value.setCookies);
    after(started.value.send);
    return { step: 'code', email };
  }
  const code = text(form, 'code').replace(/\s/g, '');
  const challenge = text(form, 'challenge');
  if (step === 'code') return { step: 'choose', code, challenge };
  const newPassword = text(form, 'password');
  const done = await auth.passwordAccount.completePasswordReset(browser, {
    code,
    newPassword,
    ...(challenge === '' ? {} : { challenge }),
  });
  if (done.ok) {
    await applyCookies([
      ...done.value.setCookies,
      ...lastMethodCookie(authConfig(), done.value.session),
    ]);
    const { send } = done.value;
    if (send !== undefined) after(send);
    return { step: 'saved', returnTo: done.value.returnTo, email: done.value.session.email };
  }
  const { error } = done;
  if (error.code === 'AUTH_PASSWORD_WEAK') {
    return { step: 'choose', code, challenge, rules: error.rules ?? [] };
  }
  if (error.code === 'AUTH_PASSWORD_BREACHED') {
    return { step: 'choose', code, challenge, breached: true };
  }
  if (error.code === 'AUTH_CODE_INVALID') return { step: 'code', email: '', wrong: true };
  if (error.code === 'AUTH_CHALLENGE_EXPIRED' || error.code === 'AUTH_CHALLENGE_BINDING') {
    return { step: 'ask', email: '', expired: true };
  }
  return { step: 'choose', code, challenge, notice: noticeOf(error, 'auth.reset_failed') };
});

export const redeemCliLink = publicAction(async ({ browser }, form): Promise<CliState> => {
  const auth = await dashboardAuth();
  const done = await auth.cliLinks.redeem(browser, text(form, 'token').trim());
  if (done.ok) return finishSignIn({ setCookies: done.value.setCookies, returnTo: '/' });
  if (done.error.code === 'AUTH_CLI_LINK_INVALID') return { kind: 'invalid' };
  return { kind: 'failed', notice: noticeOf(done.error, 'auth.cli_link_failed') };
});

async function heldToken(form: FormData): Promise<string> {
  const given = text(form, 'token');
  if (given !== '') return given;
  return (await cookies()).get(authConfig().cookies.invite)?.value ?? '';
}

export const openInvitation = publicAction(async ({ browser }, form): Promise<InviteState> => {
  const token = await heldToken(form);
  if (token === '') return { kind: 'invalid' };
  const auth = await dashboardAuth();
  const read = await auth.invitations.readInvitation(token);
  if (!read.ok) {
    if (read.error.code === 'AUTH_INVITATION_INVALID') return { kind: 'invalid' };
    return { kind: 'failed', notice: noticeOf(read.error, 'auth.invitation_read_failed') };
  }
  const view = read.value;
  const facts = {
    organizationName: view.organizationName,
    inviterName: view.inviterName,
    email: view.email,
    role: view.role,
    projectRole: view.defaultProjectRole,
    expiresAt: view.expiresAt.toISOString(),
    blockHref: `${view.blockLink.pathname}${view.blockLink.hash}`,
  };
  const session = await currentSession();
  if (session === null) {
    const held = auth.invitations.holdInvitation(browser, token);
    if (held.ok) await applyCookies(held.value.setCookies);
    return { kind: 'signed_out', ...facts };
  }
  if (normalizeAddress(session.email) !== view.email) {
    return { kind: 'mismatch', ...facts, signedInAs: session.email };
  }
  return { kind: 'match', ...facts, token };
});

export const joinInvitation = signedInAction(
  async ({ session }, _state: unknown, form: FormData): Promise<InviteState> => {
    const auth = await dashboardAuth();
    const done = await auth.invitations.acceptInvitation(session, text(form, 'token'));
    if (!done.ok) {
      if (done.error.code === 'AUTH_INVITATION_EMAIL_MISMATCH') return { kind: 'invalid' };
      if (done.error.code === 'AUTH_INVITATION_INVALID') return { kind: 'invalid' };
      return { kind: 'failed', notice: noticeOf(done.error, 'auth.invitation_accept_failed') };
    }
    await applyCookies(done.value.setCookies);
    const joined = await auth.organizations.listMyOrganizations(session);
    const organization = joined.find((o) => o.organizationId === done.value.access.organizationId);
    redirect(organization === undefined ? '/' : `/${organization.slug}`);
  },
);

export const readBlock = publicAction(async (_context, form): Promise<BlockState> => {
  const token = text(form, 'token');
  const auth = await dashboardAuth();
  const read = await auth.invitations.readInvitationBlock(token);
  if (!read.ok) {
    if (read.error.code === 'AUTH_INVITATION_INVALID') return { kind: 'invalid' };
    return { kind: 'failed', notice: noticeOf(read.error, 'auth.block_read_failed') };
  }
  return { kind: 'ask', organizationName: read.value.organizationName, token };
});

export const stopInvitations = publicAction(async (_context, form): Promise<BlockState> => {
  const token = text(form, 'token');
  const auth = await dashboardAuth();
  const read = await auth.invitations.readInvitationBlock(token);
  const done = await auth.invitations.blockInvitation(token);
  if (!done.ok || !read.ok) {
    if (!done.ok && done.error.code !== 'AUTH_INVITATION_INVALID') {
      return { kind: 'failed', notice: noticeOf(done.error, 'auth.block_failed') };
    }
    return { kind: 'invalid' };
  }
  return { kind: 'done', organizationName: read.value.organizationName };
});

'use server';
import { ApiKeyReplayError, normalizeAddress, type AuthError } from '@drefyn/auth';
import type { OrgRole, ProjectRole } from '@drefyn/auth/permissions';
import type { IdOf, ProjectId } from '@drefyn/tenancy';
import { after } from 'next/server';
import { signedInAction, orgAction } from './actions.ts';
import { dashboardAuth } from './auth.ts';
import { logWarn } from './log.ts';
import { applyCookies, failureReference } from './sign-in-support.ts';
import { minutesLeft } from '../auth/outcomes.ts';
import type {
  InviteResult,
  KeyToRevoke,
  MadeKey,
  Outcome,
  Problem,
  StepUpChoices,
} from '../settings/results.ts';

type Provider = 'github' | 'google';
type DefaultRole = 'editor' | 'viewer' | null;

const DAY_MS = 86_400_000;
// One dialog's worth: a person typing addresses, not an import.
const INVITES_MAX = 20;

function problemOf(error: AuthError, event: string): Problem {
  switch (error.code) {
    case 'AUTH_RECENT_AUTH_REQUIRED':
      return { kind: 'step_up' };
    case 'AUTH_RATE_LIMITED':
      return { kind: 'limited', minutes: minutesLeft(error.retryAfterSeconds) };
    case 'AUTH_UNAVAILABLE':
      return { kind: 'failed', reference: failureReference(event) };
    default:
      return { kind: 'refused', code: error.code };
  }
}

const refused = (error: AuthError, event: string): Outcome<never> => ({
  ok: false,
  problem: problemOf(error, event),
});

const done = <T>(value: T): Outcome<T> => ({ ok: true, value });
const nothing: Outcome = { ok: true, value: undefined };
const noRight: Outcome<never> = {
  ok: false,
  problem: { kind: 'refused', code: 'AUTH_FORBIDDEN' },
};

// Profile and email

export const saveName = signedInAction(async ({ session }, name: string) => {
  const auth = await dashboardAuth();
  const saved = await auth.account.setDisplayName(session, { name });
  return saved.ok
    ? done(saved.value.displayName)
    : refused(saved.error, 'settings.name_save_failed');
});

export const beginEmailChange = signedInAction(async ({ browser, session }, newEmail: string) => {
  const auth = await dashboardAuth();
  const started = await auth.emailChange.startEmailChange(browser, session, { newEmail });
  if (!started.ok) return refused(started.error, 'settings.email_change_failed');
  await applyCookies(started.value.setCookies);
  after(started.value.send);
  return nothing;
});

export const finishEmailChange = signedInAction(async ({ browser, session }, code: string) => {
  const auth = await dashboardAuth();
  const changed = await auth.emailChange.completeEmailChange(browser, session, { code });
  if (!changed.ok) return refused(changed.error, 'settings.email_finish_failed');
  after(changed.value.send);
  return nothing;
});

// Sign in methods

export const savePassword = signedInAction(
  async (
    { browser, session },
    input: { readonly first: boolean; readonly newPassword: string },
  ) => {
    const auth = await dashboardAuth();
    if (input.first) {
      const set = await auth.passwordSignIn.setPassword(session, input);
      if (!set.ok) return refused(set.error, 'settings.password_set_failed');
      after(set.value.send);
      return nothing;
    }
    const changed = await auth.passwordAccount.changePassword(browser, session, input);
    if (!changed.ok) return refused(changed.error, 'settings.password_change_failed');
    await applyCookies(changed.value.setCookies);
    after(changed.value.send);
    return nothing;
  },
);

export const removePassword = signedInAction(async ({ session }) => {
  const auth = await dashboardAuth();
  const removed = await auth.passwordAccount.removePassword(session);
  if (!removed.ok) return refused(removed.error, 'settings.password_remove_failed');
  after(removed.value.send);
  return nothing;
});

export const unlinkProvider = signedInAction(async ({ session }, provider: Provider) => {
  const auth = await dashboardAuth();
  const unlinked = await auth.oauth.unlinkIdentity(session, { provider });
  if (!unlinked.ok) return refused(unlinked.error, 'settings.unlink_failed');
  after(unlinked.value.send);
  return nothing;
});

// Linking leaves for the provider, so the recent sign in is asked here, where a prompt can
// still appear, before the page goes.
export const confirmRecent = signedInAction(async ({ session }) => {
  const auth = await dashboardAuth();
  const recent = await auth.sessions.requireRecentAuth(session);
  return recent.ok ? nothing : refused(recent.error, 'settings.recent_check_failed');
});

// Sessions

export const signOutSession = signedInAction(async ({ session }, id: string) => {
  const auth = await dashboardAuth();
  const gone = await auth.sessions.revokeSession(session, id as IdOf<'ses'>);
  if (gone.ok || gone.error.code === 'AUTH_NOT_FOUND') return nothing;
  return refused(gone.error, 'settings.session_revoke_failed');
});

export const signOutOthers = signedInAction(async ({ browser, session }) => {
  const auth = await dashboardAuth();
  const rotated = await auth.sessions.signOutOtherSessions(session, browser);
  if (!rotated.ok) return refused(rotated.error, 'settings.sign_out_others_failed');
  await applyCookies(rotated.value.setCookies);
  return done(rotated.value.revoked);
});

// Step up

export const stepUpChoices = signedInAction(
  async ({ session }): Promise<Outcome<StepUpChoices>> => {
    const auth = await dashboardAuth();
    const read = await auth.account.readAccount(session);
    if (!read.ok) return refused(read.error, 'settings.step_up_read_failed');
    const providers = read.value.identities.map((identity) => identity.provider);
    return done({
      address: session.email,
      lastSignIn: session.authenticatedAt.toISOString(),
      password: read.value.passwordSetAt !== null,
      email: auth.methods.email,
      google: providers.includes('google'),
      github: providers.includes('github'),
    });
  },
);

export const stepUpWithPassword = signedInAction(async ({ browser, session }, password: string) => {
  const auth = await dashboardAuth();
  const proved = await auth.sessions.stepUpWithPassword(browser, session, { password });
  return proved.ok ? nothing : refused(proved.error, 'settings.step_up_failed');
});

export const stepUpSendCode = signedInAction(async ({ browser, session }) => {
  const auth = await dashboardAuth();
  const started = await auth.sessions.startStepUpCode(browser, session);
  if (!started.ok) return refused(started.error, 'settings.step_up_send_failed');
  after(started.value.send);
  return done(started.value.challenge);
});

export const stepUpWithCode = signedInAction(
  async ({ browser, session }, challenge: string, code: string) => {
    const auth = await dashboardAuth();
    const proved = await auth.sessions.verifyStepUpCode(browser, session, { challenge, code });
    return proved.ok ? nothing : refused(proved.error, 'settings.step_up_failed');
  },
);

// Create organization

export const makeOrganization = signedInAction(
  async ({ session }, input: { readonly name: string; readonly slug: string }) => {
    const auth = await dashboardAuth();
    const made = await auth.organizations.createOrganization(session, input);
    return made.ok ? done(input.slug) : refused(made.error, 'settings.organization_failed');
  },
);

// Members

export const sendInvitations = orgAction(
  async (
    { access },
    input: {
      readonly emails: readonly string[];
      readonly role: OrgRole;
      readonly defaultProjectRole: DefaultRole;
    },
  ): Promise<Outcome<readonly InviteResult[]>> => {
    if (input.emails.length === 0 || input.emails.length > INVITES_MAX) {
      return { ok: false, problem: { kind: 'refused', code: 'AUTH_INPUT_INVALID' } };
    }
    const auth = await dashboardAuth();
    const results: InviteResult[] = [];
    let stopped = false;
    for (const email of input.emails) {
      if (stopped) {
        results.push({ email, result: 'waiting' });
        continue;
      }
      if (normalizeAddress(email) === null) {
        results.push({ email, result: 'invalid' });
        continue;
      }
      const sent = await auth.invitations.invite(access, {
        email,
        role: input.role,
        defaultProjectRole: input.defaultProjectRole,
      });
      if (sent.ok) {
        const { value } = sent;
        if (value.kind === 'sent') after(value.send);
        results.push({ email, result: value.kind === 'sent' ? 'sent' : 'blocked' });
        continue;
      }
      const { code } = sent.error;
      // Nothing has gone out yet, so the prompt can run and the whole list go after it.
      if (code === 'AUTH_RECENT_AUTH_REQUIRED' && results.length === 0) {
        return refused(sent.error, 'settings.invite_failed');
      }
      if (code === 'AUTH_ALREADY_MEMBER') {
        results.push({ email, result: 'member' });
      } else if (code === 'AUTH_SEAT_LIMIT') {
        results.push({ email, result: 'limit' });
        stopped = true;
      } else {
        logWarn('settings.invite_failed', { code });
        results.push({ email, result: 'failed' });
        stopped = code === 'AUTH_RATE_LIMITED' || code === 'AUTH_UNAVAILABLE';
      }
    }
    return done(results);
  },
);

export const resendInvitation = orgAction(
  async (
    { access },
    input: {
      readonly email: string;
      readonly role: OrgRole;
      readonly defaultProjectRole: DefaultRole;
    },
  ) => {
    const auth = await dashboardAuth();
    const sent = await auth.invitations.invite(access, input);
    if (!sent.ok) return refused(sent.error, 'settings.invite_resend_failed');
    if (sent.value.kind === 'sent') after(sent.value.send);
    return done(sent.value.kind);
  },
);

export const withdrawInvitation = orgAction(async ({ access }, id: string) => {
  const auth = await dashboardAuth();
  const gone = await auth.members.withdrawInvitation(access, id as IdOf<'inv'>);
  return gone.ok ? done(gone.value) : refused(gone.error, 'settings.invite_withdraw_failed');
});

export const changeMemberRole = orgAction(async ({ access }, member: string, role: OrgRole) => {
  const auth = await dashboardAuth();
  const changed = await auth.roles.changeRole(access, member as IdOf<'mem'>, role);
  if (!changed.ok) return refused(changed.error, 'settings.role_change_failed');
  return done({ from: changed.value.from, revokedKeys: changed.value.revokedKeyIds.length });
});

// What removal will take with it, read right before the question is asked.
export const keysOfMember = orgAction(
  async (
    { access },
    member: string,
  ): Promise<Outcome<{ keys: readonly KeyToRevoke[]; more: boolean }>> => {
    if (!access.permissions.includes('org.manage_members')) return noRight;
    const auth = await dashboardAuth();
    const page = await auth.apiKeys.listApiKeys(access, {
      createdBy: [member as IdOf<'mem'>],
      limit: 100,
    });
    if (!page.ok) return refused(page.error, 'settings.member_keys_failed');
    return done({
      keys: page.value.items
        .filter((key) => key.revokedAt === null)
        .map((key) => ({
          keyId: key.keyId,
          name: key.name,
          suffix: key.displaySuffix,
          lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
        })),
      more: page.value.nextCursor !== null,
    });
  },
);

export const removeMember = orgAction(async ({ access }, member: string) => {
  const auth = await dashboardAuth();
  const removed = await auth.roles.removeMember(access, member as IdOf<'mem'>);
  if (!removed.ok) return refused(removed.error, 'settings.member_remove_failed');
  return done(removed.value.revokedKeyIds.length);
});

export const saveProjectAccess = orgAction(
  async (
    { access },
    member: string,
    input: {
      readonly fallback?: DefaultRole;
      readonly changes: readonly {
        readonly projectId: string;
        readonly role: ProjectRole | null;
      }[];
    },
  ) => {
    const auth = await dashboardAuth();
    const id = member as IdOf<'mem'>;
    if (input.fallback !== undefined) {
      const set = await auth.members.setDefaultProjectRole(access, id, input.fallback);
      if (!set.ok) return refused(set.error, 'settings.project_access_failed');
    }
    for (const { projectId, role } of input.changes) {
      const set = await auth.roles.setProjectRole(access, id, projectId as ProjectId, role);
      if (!set.ok) return refused(set.error, 'settings.project_access_failed');
    }
    return nothing;
  },
);

// API keys

export const createKey = orgAction(
  async (
    { access },
    input: {
      readonly name: string;
      readonly scopes: readonly string[];
      readonly projectScope: 'all' | 'listed';
      readonly projectIds: readonly string[];
      readonly expiresInDays: number | null;
      readonly idempotencyKey: string;
    },
  ): Promise<Outcome<MadeKey>> => {
    const auth = await dashboardAuth();
    const made = await auth.apiKeys.createApiKey(access, {
      name: input.name,
      scopes: input.scopes,
      projectScope: input.projectScope,
      ...(input.projectScope === 'listed' ? { projectIds: input.projectIds as ProjectId[] } : {}),
      ...(input.expiresInDays === null
        ? {}
        : { expiresAt: new Date(Date.now() + input.expiresInDays * DAY_MS) }),
      idempotencyKey: input.idempotencyKey,
    });
    if (!made.ok) {
      if (made.error instanceof ApiKeyReplayError) {
        return { ok: false, problem: { kind: 'refused', code: 'AUTH_IDEMPOTENCY_REPLAY' } };
      }
      return refused(made.error, 'settings.key_create_failed');
    }
    const { key, secret, send } = made.value;
    after(send);
    return done({
      name: key.name,
      secret,
      scopes: key.scopes,
      projectScope: key.projectScope,
      projectIds: key.projectIds,
      expiresAt: key.expiresAt?.toISOString() ?? null,
    });
  },
);

export const revokeKey = orgAction(async ({ access }, id: string) => {
  const auth = await dashboardAuth();
  const revoked = await auth.apiKeys.revokeApiKey(access, id as IdOf<'key'>);
  if (!revoked.ok) return refused(revoked.error, 'settings.key_revoke_failed');
  // Sends nothing when an earlier call got there first, so a retry reads as plain success.
  after(revoked.value.send);
  return nothing;
});

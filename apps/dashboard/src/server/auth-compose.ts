import {
  API_KEY_SCOPES,
  createAccount,
  createApiKeys,
  createCliLinks,
  createEmailChange,
  createEmailSignIn,
  createFactorChallenges,
  createInvitations,
  createMembers,
  createOAuth,
  createOrganizations,
  createPasswordAccount,
  createPasswordHasher,
  createPasswordSignIn,
  createRateLimiter,
  createRoles,
  createScopeRegistry,
  createSecondFactors,
  createSessions,
  loadBreachedPasswords,
  type Account,
  type ApiKeys,
  type CliLinks,
  type FactorChallenges,
  type EmailChange,
  type EmailSignIn,
  type Invitations,
  type Members,
  type OAuth,
  type Organizations,
  type PasswordAccount,
  type PasswordSignIn,
  type Roles,
  type SecondFactors,
  type Sessions,
} from '@drefyn/auth';
import type { AuthDatabase, Database } from '@drefyn/db';
import { signInMethods, type SignInMethods } from '../auth/outcomes.ts';
import { authLogger } from './auth-logger.ts';
import { mailableOrganizationName, organizationNames } from './organization-name.ts';
import { dashboardMail, noteEmailOff } from './auth-mailer.ts';
import { authConfig } from './auth-config.ts';
import { totpFlag } from './flags.ts';
import { mailDeliveryEnabled } from './gate.ts';
import { afterResponse } from './later.ts';

// Only what the dashboard calls. Each page issue adds what it needs, so nothing here is
// wiring that no test reaches, and ensureOrganizationFor, which takes a bare user id, stays
// out of reach.
export interface DashboardAuth {
  readonly sessions: Pick<
    Sessions,
    | 'resolveAccess'
    | 'resolveSession'
    | 'touchSession'
    | 'signOut'
    | 'listSessions'
    | 'revokeSession'
    | 'signOutOtherSessions'
    | 'requireRecentAuth'
    | 'stepUpWithPassword'
    | 'startStepUpCode'
    | 'verifyStepUpCode'
  >;
  readonly organizations: Pick<
    Organizations,
    'listMyOrganizations' | 'listMyOrganizationSeats' | 'createOrganization'
  >;
  readonly account: Pick<Account, 'readAccount' | 'setDisplayName'>;
  readonly emailSignIn: EmailSignIn;
  readonly emailChange: EmailChange;
  readonly passwordSignIn: Pick<PasswordSignIn, 'signInWithPassword' | 'setPassword'>;
  readonly passwordAccount: Pick<
    PasswordAccount,
    'startPasswordReset' | 'completePasswordReset' | 'changePassword' | 'removePassword'
  >;
  readonly oauth: Pick<OAuth, 'startOAuth' | 'completeOAuth' | 'unlinkIdentity'>;
  readonly invitations: Pick<
    Invitations,
    | 'acceptInvitation'
    | 'blockInvitation'
    | 'holdInvitation'
    | 'readInvitation'
    | 'readInvitationBlock'
    | 'invite'
    | 'seatUsage'
  >;
  readonly cliLinks: Pick<CliLinks, 'redeem'>;
  readonly factorChallenges: FactorChallenges;
  readonly secondFactors: SecondFactors;
  readonly members: Members;
  readonly roles: Pick<Roles, 'changeRole' | 'removeMember' | 'setProjectRole'>;
  readonly apiKeys: Pick<ApiKeys, 'createApiKey' | 'revokeApiKey' | 'listApiKeys'>;
  readonly methods: SignInMethods;
}

const logger = authLogger;

// Runs once per process, inside the engine holder's build. A handle works only with the copy
// of @drefyn/db that opened it, and Next loads a copy per server layer, so everything that
// touches the handles is composed in the one copy that opened them.
export async function composeAuth(db: Database, authDb: AuthDatabase): Promise<DashboardAuth> {
  const parsed = authConfig();
  const mail = await dashboardMail({
    linkOrigin: new URL(parsed.appOrigin),
    organizationName: mailableOrganizationName(organizationNames(db)),
    enabled: mailDeliveryEnabled,
  });
  noteEmailOff(mail, parsed.email);
  const mailer = mail.auth;
  const limiter = createRateLimiter({
    db: authDb,
    keys: parsed.keys,
    limits: parsed.rateLimits,
    logger,
  });
  // One hasher, so one gate bounds every hash in this process.
  const hasher = createPasswordHasher({
    params: parsed.passwords.argon2,
    concurrency: parsed.passwords.hashConcurrency,
    queueMax: parsed.passwords.hashQueueMax,
  });
  const breachedPasswords = await loadBreachedPasswords(parsed, logger);
  const sessions = createSessions(parsed, {
    db,
    authDb,
    logger,
    mailer,
    limiter,
    passwords: hasher,
  });
  // New organizations take the install's own tier; hosted refuses this one in the database,
  // so the cloud root passes its own.
  const organizations = createOrganizations(parsed, {
    db,
    authDb,
    logger,
    limiter,
    initialTier: 'self_hosted',
  });
  const invitations = createInvitations(parsed, { db, authDb, logger, mailer, limiter });
  const shared = { db, authDb, logger, mailer, limiter, sessions };
  const emailChange = createEmailChange(parsed, { db, authDb, logger, mailer, limiter });
  const account = createAccount({ db, authDb, logger });
  const members = createMembers({ db, logger });
  const roles = createRoles({ db, logger, mailer });
  const apiKeys = createApiKeys({
    db,
    authDb,
    logger,
    mailer,
    scopes: createScopeRegistry(
      API_KEY_SCOPES.map(({ scope, permission }) => ({ scope, permission })),
    ),
  });
  const emailSignIn = createEmailSignIn(parsed, { ...shared, invitations });
  const passwordSignIn = createPasswordSignIn(parsed, {
    ...shared,
    hasher,
    breachedPasswords,
  });
  const passwordAccount = createPasswordAccount(parsed, {
    ...shared,
    hasher,
    breachedPasswords,
    later: afterResponse,
  });
  const oauth = createOAuth(parsed, { ...shared, invitations });
  const factors = { db, authDb, logger, mailer, limiter, later: afterResponse };
  const factorChallenges = createFactorChallenges(parsed, factors);
  const secondFactors = createSecondFactors(parsed, { ...factors, flag: totpFlag });
  const cliLinks = createCliLinks(parsed, {
    db,
    authDb,
    logger,
    limiter,
    sessions,
    organizations,
    initialTier: 'self_hosted',
  });
  return {
    sessions: {
      resolveAccess: (cookie, slug) => sessions.resolveAccess(cookie, slug),
      resolveSession: (cookie) => sessions.resolveSession(cookie),
      touchSession: (ref) => sessions.touchSession(ref),
      signOut: (session) => sessions.signOut(session),
      listSessions: (session) => sessions.listSessions(session),
      revokeSession: (session, id) => sessions.revokeSession(session, id),
      signOutOtherSessions: (session, b) => sessions.signOutOtherSessions(session, b),
      requireRecentAuth: (session) => sessions.requireRecentAuth(session),
      stepUpWithPassword: (b, session, input) => sessions.stepUpWithPassword(b, session, input),
      startStepUpCode: (b, session) => sessions.startStepUpCode(b, session),
      verifyStepUpCode: (b, session, input) => sessions.verifyStepUpCode(b, session, input),
    },
    organizations: {
      listMyOrganizations: (session) => organizations.listMyOrganizations(session),
      listMyOrganizationSeats: (access) => organizations.listMyOrganizationSeats(access),
      createOrganization: (session, input) => organizations.createOrganization(session, input),
    },
    account: {
      readAccount: (session) => account.readAccount(session),
      setDisplayName: (session, input) => account.setDisplayName(session, input),
    },
    emailSignIn,
    emailChange,
    passwordSignIn: {
      signInWithPassword: (b, input) => passwordSignIn.signInWithPassword(b, input),
      setPassword: (session, input) => passwordSignIn.setPassword(session, input),
    },
    passwordAccount: {
      startPasswordReset: (b, input) => passwordAccount.startPasswordReset(b, input),
      completePasswordReset: (b, input) => passwordAccount.completePasswordReset(b, input),
      changePassword: (b, session, input) => passwordAccount.changePassword(b, session, input),
      removePassword: (session) => passwordAccount.removePassword(session),
    },
    oauth: {
      startOAuth: (b, input) => oauth.startOAuth(b, input),
      completeOAuth: (b, input) => oauth.completeOAuth(b, input),
      unlinkIdentity: (session, input) => oauth.unlinkIdentity(session, input),
    },
    invitations: {
      acceptInvitation: (s, token) => invitations.acceptInvitation(s, token),
      blockInvitation: (token) => invitations.blockInvitation(token),
      holdInvitation: (b, token) => invitations.holdInvitation(b, token),
      readInvitation: (token) => invitations.readInvitation(token),
      readInvitationBlock: (token) => invitations.readInvitationBlock(token),
      invite: (access, input) => invitations.invite(access, input),
      seatUsage: (access) => invitations.seatUsage(access),
    },
    cliLinks: { redeem: (b, token) => cliLinks.redeem(b, token) },
    factorChallenges,
    secondFactors,
    members,
    roles: {
      changeRole: (access, member, role) => roles.changeRole(access, member, role),
      removeMember: (access, member) => roles.removeMember(access, member),
      setProjectRole: (access, member, project, role) =>
        roles.setProjectRole(access, member, project, role),
    },
    apiKeys: {
      createApiKey: (access, input) => apiKeys.createApiKey(access, input),
      revokeApiKey: (access, id) => apiKeys.revokeApiKey(access, id),
      listApiKeys: (access, input) => apiKeys.listApiKeys(access, input),
    },
    methods: signInMethods(parsed, mail.configured),
  };
}

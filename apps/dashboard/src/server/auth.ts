import {
  createAccount,
  createCliLinks,
  createEmailSignIn,
  createInvitations,
  createOAuth,
  createOrganizations,
  createPasswordAccount,
  createPasswordHasher,
  createPasswordSignIn,
  createRateLimiter,
  createSessions,
  loadBreachedPasswords,
  parseAuthConfig,
  type Account,
  type AuthConfig,
  type AuthLogger,
  type CliLinks,
  type EmailSignIn,
  type Env,
  type Invitations,
  type OAuth,
  type Organizations,
  type PasswordAccount,
  type PasswordSignIn,
  type Sessions,
} from '@drefyn/auth';
import {
  createAuthDatabase,
  createDatabase,
  parseAuthDatabaseConfig,
  parseDatabaseConfig,
  withOrganization,
  type Database,
} from '@drefyn/db';
import { parseEmailConfig } from '@drefyn/email/config';
import { signInMethods, type SignInMethods } from '../auth/outcomes.ts';
import { mailableOrganizationName } from './organization-name.ts';
import { dashboardMail, noteEmailOff, type OrganizationName } from './auth-mailer.ts';
import { mailDeliveryEnabled } from './gate.ts';
import { logInfo, logWarn, type LogContext } from './log.ts';

// Only what the dashboard calls. Each page issue adds what it needs, so nothing here is
// wiring that no test reaches, and createOrganizationFor, which takes a bare user id, stays
// out of reach.
export interface DashboardAuth {
  readonly sessions: Pick<
    Sessions,
    'resolveAccess' | 'resolveSession' | 'touchSession' | 'signOut'
  >;
  readonly organizations: Pick<Organizations, 'listMyOrganizations' | 'createOrganization'>;
  readonly account: Pick<Account, 'readAccount' | 'setDisplayName'>;
  readonly emailSignIn: EmailSignIn;
  readonly passwordSignIn: Pick<PasswordSignIn, 'signInWithPassword' | 'setPassword'>;
  readonly passwordAccount: Pick<PasswordAccount, 'startPasswordReset' | 'completePasswordReset'>;
  readonly oauth: Pick<OAuth, 'startOAuth' | 'completeOAuth'>;
  readonly invitations: Pick<
    Invitations,
    | 'acceptInvitation'
    | 'blockInvitation'
    | 'holdInvitation'
    | 'readInvitation'
    | 'readInvitationBlock'
  >;
  readonly cliLinks: Pick<CliLinks, 'redeem'>;
  readonly methods: SignInMethods;
}

// Auth passes ids and outcome codes; a value of any other shape stays out of the log.
function plainFields(fields: Readonly<Record<string, unknown>>): LogContext {
  const kept: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (['string', 'number', 'boolean'].includes(typeof value)) {
      kept[key] = value as string | number | boolean;
    }
  }
  return kept;
}

const logger: AuthLogger = {
  info: (event, fields) => {
    logInfo(event, plainFields(fields));
  },
  warn: (event, fields) => {
    logWarn(event, plainFields(fields));
  },
};

let config: AuthConfig | undefined;

export function authConfig(): AuthConfig {
  config ??= parseAuthConfig(process.env);
  return config;
}

export function sessionCookieName(): string {
  return authConfig().cookies.session;
}

function organizationNames(db: Database): OrganizationName {
  return async (organizationId) => {
    const row = await withOrganization(db, { organizationId }, (tx) =>
      tx
        .selectFrom('organizations')
        .select('name')
        .where('organization_id', '=', organizationId)
        .executeTakeFirstOrThrow(),
    );
    return row.name;
  };
}

async function compose(): Promise<DashboardAuth> {
  const parsed = authConfig();
  const db = await createDatabase(parseDatabaseConfig(process.env));
  const authDb = await createAuthDatabase(parseAuthDatabaseConfig(process.env));
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
  const emailSignIn = createEmailSignIn(parsed, { ...shared, invitations });
  const account = createAccount({ db, authDb, logger });
  const passwordSignIn = createPasswordSignIn(parsed, {
    ...shared,
    hasher,
    breachedPasswords,
  });
  const passwordAccount = createPasswordAccount(parsed, { ...shared, hasher, breachedPasswords });
  const oauth = createOAuth(parsed, { ...shared, invitations });
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
    },
    organizations: {
      listMyOrganizations: (session) => organizations.listMyOrganizations(session),
      createOrganization: (session, input) => organizations.createOrganization(session, input),
    },
    account: {
      readAccount: (session) => account.readAccount(session),
      setDisplayName: (session, input) => account.setDisplayName(session, input),
    },
    emailSignIn,
    passwordSignIn: {
      signInWithPassword: (b, input) => passwordSignIn.signInWithPassword(b, input),
      setPassword: (session, input) => passwordSignIn.setPassword(session, input),
    },
    passwordAccount: {
      startPasswordReset: (b, input) => passwordAccount.startPasswordReset(b, input),
      completePasswordReset: (b, input) => passwordAccount.completePasswordReset(b, input),
    },
    oauth: {
      startOAuth: (b, input) => oauth.startOAuth(b, input),
      completeOAuth: (b, input) => oauth.completeOAuth(b, input),
    },
    invitations: {
      acceptInvitation: (s, token) => invitations.acceptInvitation(s, token),
      blockInvitation: (token) => invitations.blockInvitation(token),
      holdInvitation: (b, token) => invitations.holdInvitation(b, token),
      readInvitation: (token) => invitations.readInvitation(token),
      readInvitationBlock: (token) => invitations.readInvitationBlock(token),
    },
    cliLinks: { redeem: (b, token) => cliLinks.redeem(b, token) },
    methods: signInMethods(parsed, mail.configured),
  };
}

let built: Promise<DashboardAuth> | undefined;

// Built on first use, so next build needs no database. A failed start is dropped, so the
// next request tries again instead of keeping sign in down until a restart.
export function dashboardAuth(): Promise<DashboardAuth> {
  built ??= compose().catch((error: unknown) => {
    built = undefined;
    throw error;
  });
  return built;
}

// At boot, connecting to nothing: a bad key stops the start and names the key.
export function checkDashboardConfig(env: Env): void {
  parseAuthConfig(env);
  parseDatabaseConfig(env);
  parseAuthDatabaseConfig(env);
  const email = parseEmailConfig(env);
  if (!email.ok) throw new Error(`${email.error.key} ${email.error.reason}`);
}

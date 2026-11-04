import { randomBytes } from 'node:crypto';
import {
  closeDatabase,
  createAuthDatabase,
  createDatabase,
  newId,
  parseAuthDatabaseConfig,
  parseDatabaseConfig,
  withAuth,
  type AuthDatabase,
  type Database,
} from '@drefyn/db';
import type { UserId } from '@drefyn/tenancy';
import { afterAll, describe, inject } from 'vitest';
import {
  createApiKeyVerifier,
  createApiKeys,
  createInvitations,
  createOrganizations,
  createRoles,
  createScopeRegistry,
  createSessions,
  parseAuthConfig,
  type ApiKeyVerifier,
  type ApiKeyVerifierDeps,
  type ApiKeys,
  type ApiKeysDeps,
  type AuthConfig,
  type AuthLogger,
  type Env,
  type InvitationSend,
  type InvitationsDeps,
  type OrganizationsDeps,
  type Roles,
  type RolesDeps,
  type ScopeRegistry,
  type SessionsDeps,
} from '../../../src/index.ts';
import { createTestAuthMailer, type TestAuthMailer } from '../../../src/testing.ts';
import { validEnv } from '../../support.ts';
import { cloneDatabase, dropDatabase, newName } from './global-setup.ts';
import { superuser, urlFor } from './stack.ts';

// The scopes the API key tests register, one per product read plus a project scope.
export const TEST_SCOPES: ScopeRegistry = createScopeRegistry([
  { scope: 'docs:read', permission: 'docs.read' },
  { scope: 'studio:read', permission: 'studio.read' },
  { scope: 'status:read', permission: 'status.read' },
  { scope: 'docs:projects.create', permission: 'project.create' },
]);

export const API_RATE_KEY = randomBytes(32).toString('base64url');

export function describeWithStack(name: string, body: () => void): void {
  const absent = inject('authStackAbsent');
  if (absent === null) describe(name, body);
  else describe.skip(`${name} [skipped, no compose stack: ${absent}]`, body);
}

export interface Harness {
  readonly name: string;
  readonly db: Database;
  readonly authDb: AuthDatabase;
  readonly config: AuthConfig;
  sql(text: string): Promise<string>;
  user(email?: string): Promise<UserId>;
  sessions(extra?: Partial<SessionsDeps>): ReturnType<typeof createSessions>;
  organizations(extra?: Partial<OrganizationsDeps>): ReturnType<typeof createOrganizations>;
  apiKeys(extra?: Partial<ApiKeysDeps>): ApiKeys;
  // The API service's side: drefyn_app only, with its own failure key.
  verifier(extra?: Partial<ApiKeyVerifierDeps>, env?: Env): ApiKeyVerifier;
  readonly mail: TestAuthMailer;
  invitations(
    extra?: Partial<InvitationsDeps>,
    config?: AuthConfig,
  ): ReturnType<typeof createInvitations>;
  roles(extra?: Partial<RolesDeps>): Roles;
  // Every invitation mail any invitations() instance sent, in order.
  readonly invitationMail: { to: string; invitation: InvitationSend }[];
  readonly logs: { level: 'info' | 'warn'; event: string; fields: unknown }[];
}

// One database per file, cloned from the migrated template and dropped after the file. The
// pool sizes can be cut to 1 to prove a flow never holds a connection while it waits.
export function harness(pools: { readonly app?: number; readonly auth?: number } = {}) {
  const created: string[] = [];
  const open: (Database | AuthDatabase)[] = [];
  afterAll(async () => {
    for (const db of open.splice(0)) await closeDatabase(db).catch(() => undefined);
    for (const name of created.splice(0)) await dropDatabase(name);
  });
  return async (): Promise<Harness> => {
    const name = newName('f');
    created.push(name);
    await cloneDatabase(inject('authTemplate'), name);
    const db = await createDatabase(
      parseDatabaseConfig({
        DREFYN_DATABASE_URL: urlFor('app', name),
        DREFYN_DATABASE_SSL: 'disable',
        DREFYN_DATABASE_POOL_MAX: String(pools.app ?? 10),
        DREFYN_DATABASE_POOL_WAIT_MS: '10000',
      }),
    );
    open.push(db);
    const authDb = await createAuthDatabase(
      parseAuthDatabaseConfig({
        DREFYN_AUTH_DATABASE_URL: urlFor('auth', name),
        DREFYN_DATABASE_SSL: 'disable',
        DREFYN_AUTH_DATABASE_POOL_MAX: String(pools.auth ?? 4),
        DREFYN_DATABASE_POOL_WAIT_MS: '10000',
      }),
    );
    open.push(authDb);
    const config = parseAuthConfig(validEnv(randomBytes(32).toString('base64url')));
    const logs: { level: 'info' | 'warn'; event: string; fields: unknown }[] = [];
    const invitationMail: { to: string; invitation: InvitationSend }[] = [];
    const logger: AuthLogger = {
      info(event, fields) {
        logs.push({ level: 'info', event, fields });
      },
      warn(event, fields) {
        logs.push({ level: 'warn', event, fields });
      },
    };
    const mail = createTestAuthMailer();
    return {
      name,
      db,
      authDb,
      config,
      logs,
      mail,
      invitationMail,
      sql: (text) => superuser(text, name),
      // Sign up is drefyn_auth's job, so users are made the way it makes them.
      async user(email = `p${randomBytes(4).toString('hex')}@example.com`) {
        const id = newId('usr');
        await withAuth(authDb, (tx) =>
          tx
            .insertInto('users')
            .values({ id, email, email_normalized: email, email_verified_at: new Date() })
            .execute(),
        );
        return id;
      },
      sessions: (extra = {}) => createSessions(config, { db, authDb, logger, ...extra }),
      organizations: (extra = {}) =>
        createOrganizations(config, {
          db,
          authDb,
          logger,
          initialTier: 'self_hosted',
          ...extra,
        }),
      apiKeys: (extra = {}) =>
        createApiKeys({ db, authDb, logger, scopes: TEST_SCOPES, mailer: mail.mailer, ...extra }),
      roles: (extra = {}) => createRoles({ db, logger, mailer: mail.mailer, ...extra }),
      verifier: (extra = {}, env = { DREFYN_API_RATE_LIMIT_KEY: API_RATE_KEY }) =>
        createApiKeyVerifier(env, { db, logger, ...extra }),
      invitations: (extra = {}, other = config) =>
        createInvitations(other, {
          db,
          authDb,
          logger,
          mailer: {
            sendInvitation(to, invitation) {
              invitationMail.push({ to, invitation });
              return Promise.resolve();
            },
          },
          ...extra,
        }),
    };
  };
}

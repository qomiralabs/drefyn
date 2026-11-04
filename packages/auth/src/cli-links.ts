import type { Result } from '@drefyn/address';
import { newId, withAuth, type AuthDatabase, type AuthSchema, type Database } from '@drefyn/db';
import { idOf, type OrganizationId, type UserId } from '@drefyn/tenancy';
import { randomBytes } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { normalizeAddress } from './address.ts';
import { rateKeyForIp } from './client-ip.ts';
import type { AuthConfig } from './config.ts';
import type { BrowserContext } from './cookies.ts';
import { AuthError } from './errors.ts';
import { sha256 } from './keys.ts';
import {
  parseOrganizationName,
  parseSlug,
  slugFromOrganizationName,
} from './organization-rules.ts';
import { createOrganizations, type InitialTier, type Organizations } from './organizations.ts';
import {
  createRateLimiter,
  type AuthLogger,
  type AuthMetrics,
  type CliLinkOutcome,
  type RateLimiter,
} from './rate-limiter.ts';
import { fail, idFields, ok, quietInfo, unavailable } from './session-support.ts';
import { createSessions, type Sessions, type StartedSession } from './sessions.ts';
import { SECRET_BYTES, formatCliLinkToken, parseCliLinkToken } from './tokens.ts';

// The single use sign in link an operator prints with drefyn auth link, so the first admin
// of a fresh self host needs no SMTP and no OAuth app. The link is shown only on the
// operator's terminal and never mailed: nothing here takes a mailer.

export const CLI_LINK_PATH = '/sign-in/cli';
const LIFETIME = sql<Date>`now() + interval '15 minutes'`;

export interface CliLinkStore {
  auth<T>(work: (tx: Transaction<AuthSchema>) => Promise<T>): Promise<T>;
}

export interface CliLinksDeps {
  readonly db: Database;
  readonly authDb: AuthDatabase;
  readonly logger: AuthLogger;
  // The tier a new organization starts on; self_hosted for the operator command.
  readonly initialTier: InitialTier;
  readonly sessions?: Sessions;
  readonly organizations?: Organizations;
  readonly limiter?: Pick<RateLimiter, 'reserve'>;
  readonly metrics?: AuthMetrics;
  readonly store?: CliLinkStore;
  readonly random?: (bytes: number) => Uint8Array;
}

export interface CliLinkInput {
  readonly email: string;
  // Creates an organization with this name, the person as its owner.
  readonly organizationName?: string;
}

export interface CheckedCliLinkInput {
  readonly address: string;
  readonly organization: { readonly name: string; readonly slug: string } | null;
}

export interface IssuedCliLink {
  // Absolute, from the configured origin; the secret is in the fragment.
  readonly link: string;
  readonly userId: UserId;
  readonly organizationId: OrganizationId | null;
}

export interface CliLinks {
  issue(input: CliLinkInput): Promise<Result<IssuedCliLink, AuthError>>;
  redeem(b: BrowserContext, token: unknown): Promise<Result<StartedSession, AuthError>>;
}

// Every rule the command can check without a database, so bad input never opens one.
export function checkCliLinkInput(input: CliLinkInput): Result<CheckedCliLinkInput, AuthError> {
  const address = normalizeAddress(input.email);
  if (address === null) return fail(new AuthError('AUTH_INPUT_INVALID'));
  if (input.organizationName === undefined) return ok({ address, organization: null });
  const name = parseOrganizationName(input.organizationName);
  if (!name.ok) return name;
  const slug = parseSlug(slugFromOrganizationName(name.value));
  if (!slug.ok) return slug;
  return ok({ address, organization: { name: name.value, slug: slug.value } });
}

export function createCliLinks(config: AuthConfig, deps: CliLinksDeps): CliLinks {
  const store: CliLinkStore = deps.store ?? { auth: (work) => withAuth(deps.authDb, work) };
  const limiter =
    deps.limiter ??
    createRateLimiter({
      db: deps.authDb,
      keys: config.keys,
      limits: config.rateLimits,
      logger: deps.logger,
    });
  const random = deps.random ?? ((n: number) => randomBytes(n));
  const sessions = (): Sessions =>
    deps.sessions ??
    createSessions(config, { db: deps.db, authDb: deps.authDb, logger: deps.logger });
  const organizations = (): Organizations =>
    deps.organizations ??
    createOrganizations(config, {
      db: deps.db,
      authDb: deps.authDb,
      logger: deps.logger,
      initialTier: deps.initialTier,
    });

  function count(outcome: CliLinkOutcome): void {
    try {
      deps.metrics?.increment('auth.cli_link', { outcome });
    } catch {
      // A metric is never worth a failed sign in.
    }
  }

  function refused(reason: Exclude<CliLinkOutcome, 'redeemed'>): void {
    quietInfo(deps.logger, 'auth.cli_link_refused', { reason });
    count(reason);
  }

  // The person the address belongs to, made now when the sign up mode allows it. The
  // operator vouches for the address, so it is stored as verified, as a proved one is.
  async function userFor(address: string): Promise<Result<UserId, AuthError>> {
    const existing = await store.auth((tx) =>
      tx
        .selectFrom('users')
        .select('id')
        .where('email_normalized', '=', address)
        .executeTakeFirst(),
    );
    if (existing !== undefined) return ok(idOf('usr', existing.id));
    if (config.signUp === 'closed') return fail(new AuthError('AUTH_SIGNUP_CLOSED'));
    const id = newId('usr');
    const row = await store.auth(async (tx) => {
      const made = await tx
        .insertInto('users')
        .values({
          id,
          email: address,
          email_normalized: address,
          email_verified_at: sql<Date>`now()`,
        })
        .onConflict((c) => c.column('email_normalized').doNothing())
        .returning('id')
        .executeTakeFirst();
      return (
        made ??
        (await tx
          .selectFrom('users')
          .select('id')
          .where('email_normalized', '=', address)
          .executeTakeFirstOrThrow())
      );
    });
    return ok(idOf('usr', row.id));
  }

  return Object.freeze({
    async issue(input) {
      const checked = checkCliLinkInput(input);
      if (!checked.ok) return checked;
      const { address, organization } = checked.value;
      try {
        const user = await userFor(address);
        if (!user.ok) return user;
        const userId = user.value;
        let organizationId: OrganizationId | null = null;
        if (organization !== null) {
          const made = await organizations().createOrganizationFor(userId, organization);
          if (!made.ok) return made;
          organizationId = made.value.organizationId;
        }
        const secret = random(SECRET_BYTES);
        await store.auth(async (tx) => {
          // One live link per person: a new one makes every unused older one worthless.
          await tx
            .deleteFrom('cli_sign_in_links')
            .where('user_id', '=', userId)
            .where('consumed_at', 'is', null)
            .execute();
          await tx
            .insertInto('cli_sign_in_links')
            .values({ user_id: userId, secret_hash: sha256(secret), expires_at: LIFETIME })
            .execute();
        });
        quietInfo(deps.logger, 'auth.cli_link_created', idFields({ userId: ['usr', userId] }));
        return ok({
          link: `${config.appOrigin}${CLI_LINK_PATH}#${formatCliLinkToken(secret)}`,
          userId,
          organizationId,
        });
      } catch (error) {
        return fail(unavailable(error));
      }
    },

    async redeem(b, token) {
      let clientKey: string;
      try {
        clientKey = rateKeyForIp(b.ip);
      } catch (error) {
        refused('client_address');
        return fail(error);
      }
      // Counted first, so a flood of guesses costs one reservation each and nothing more.
      try {
        await limiter.reserve('cli_link_verify', [clientKey]);
      } catch (error) {
        if (error instanceof AuthError && error.code === 'AUTH_RATE_LIMITED') {
          refused('rate_limited');
          return fail(error);
        }
        refused('unavailable');
        return fail(new AuthError('AUTH_UNAVAILABLE', { cause: error }));
      }
      const secret = parseCliLinkToken(token);
      if (secret === null) {
        refused('malformed');
        return fail(new AuthError('AUTH_CLI_LINK_INVALID'));
      }
      let userId: UserId;
      try {
        // One statement keyed by the hash of 256 random bits: a wrong secret matches no row
        // and writes nothing, and two redemptions of one link cannot both get the row.
        const row = await store.auth((tx) =>
          tx
            .updateTable('cli_sign_in_links')
            .set({ consumed_at: sql<Date>`now()` })
            .where('secret_hash', '=', sha256(secret))
            .where('consumed_at', 'is', null)
            .where('expires_at', '>', sql<Date>`now()`)
            .returning('user_id')
            .executeTakeFirst(),
        );
        if (row === undefined) {
          refused('no_match');
          return fail(new AuthError('AUTH_CLI_LINK_INVALID'));
        }
        userId = idOf('usr', row.user_id);
      } catch (error) {
        refused('unavailable');
        return fail(unavailable(error));
      }
      // The link stays used if this fails; the operator prints another.
      try {
        const started = await sessions().startSession(b, { userId, method: 'cli_link' });
        quietInfo(deps.logger, 'auth.cli_link_redeemed', idFields({ userId: ['usr', userId] }));
        count('redeemed');
        return ok(started);
      } catch (error) {
        refused('unavailable');
        return fail(unavailable(error));
      }
    },
  } satisfies CliLinks);
}

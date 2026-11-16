import { randomBytes } from 'node:crypto';
import type { Result } from '@drefyn/address';
import { DbError } from '@drefyn/db';
import { hasFeature } from '@drefyn/entitlements';
import { idOf, type OrganizationId, type UserId } from '@drefyn/tenancy';
import { storedPermissions, storedTier, type AccessContext } from './access.ts';
import type { AuthEvent, AuthEventSink, SsoConnectionId, SsoDomainId } from './auth-events.ts';
import { AuthError, type AuthErrorCode } from './errors.ts';
import { constantTimeEqual, sha256, type AuthKeys } from './keys.ts';
import type { AuthLogger, RateLimiter } from './rate-limiter.ts';
import { asId, fail, idFields, ok, quietInfo, quietWarn } from './session-support.ts';
import type { TxtLookup, TxtResolver } from './sso-dns.ts';
import {
  createSsoDomainRepository,
  type SsoDomainOps,
  type SsoDomainRepository,
  type SsoDomainRepositoryDeps,
  type StoredSsoDomain,
  type VerifiedSsoDomainRef,
} from './sso-domain-store.ts';
import { normalizeSsoDomain, ssoTxtName, type SsoDomainPolicy } from './sso-domain-rules.ts';

export interface SsoDomainClaim {
  readonly domainId: SsoDomainId;
  readonly txtName: string;
  // null for a domain already verified: its record is published and proved, and only the
  // hash of that value was kept, so there is nothing new to publish.
  readonly txtValue: string | null;
  readonly verified: boolean;
}

export interface SsoDomainView {
  readonly domainId: SsoDomainId;
  readonly connectionId: SsoConnectionId;
  readonly domain: string;
  readonly verifiedAt: Date | null;
  readonly lastCheckedAt: Date | null;
  readonly failedChecks: number;
}

// To every owner. The domain is named, since owners must know which one changed; this is
// the only place it leaves the database in clear.
export interface SsoDomainNotice {
  readonly kind: 'sso_domain_claimed' | 'sso_domain_verified' | 'sso_domain_unverified';
  readonly organizationId: OrganizationId;
  readonly domainId: SsoDomainId;
  readonly domain: string;
  readonly at: Date;
}

export interface SsoDomainNoticeMailer {
  sendSsoDomainNotice(to: string, notice: SsoDomainNotice): Promise<void>;
}

// The part of the flag client this needs, so a FlagClient fits as it is.
export interface TeamSsoFlag {
  isOn(
    name: 'auth.team_sso',
    ctx: { readonly organizationId: OrganizationId; readonly userId?: string },
  ): Promise<boolean>;
}

export interface SsoDomains {
  // Idempotent on the organization and domain: a repeat claim returns the same row. While
  // unverified it issues a fresh token, since only the hash of the last one was kept.
  claimDomain(
    ctx: AccessContext,
    connectionId: SsoConnectionId,
    domain: string,
  ): Promise<Result<SsoDomainClaim, AuthError>>;
  verifyDomain(
    ctx: AccessContext,
    domainId: SsoDomainId,
  ): Promise<Result<SsoDomainView, AuthError>>;
}

interface SharedDeps extends SsoDomainRepositoryDeps {
  readonly repository?: SsoDomainRepository;
  readonly keys: AuthKeys;
  readonly resolver: TxtResolver;
  readonly flag: TeamSsoFlag;
  readonly logger: AuthLogger;
  readonly mailer: SsoDomainNoticeMailer;
  readonly events: AuthEventSink;
}

export interface SsoDomainsDeps extends SharedDeps {
  readonly limiter: RateLimiter;
  readonly policy: SsoDomainPolicy;
  readonly random?: (bytes: number) => Uint8Array;
}

export interface SsoDomainRecheckDeps extends SharedDeps {
  // Verified domains read per statement while walking the list.
  readonly pageSize?: number;
  // Lookups per run, so one run has a known worst case however many domains exist.
  readonly maxPerRun?: number;
}

export interface SsoDomainRecheckSummary {
  readonly checked: number;
  readonly confirmed: number;
  readonly missed: number;
  readonly unknown: number;
  readonly unverified: number;
  readonly skipped: number;
  readonly failed: number;
  // The run stopped at maxPerRun with domains left to look at.
  readonly more: boolean;
}

export interface SsoDomainRecheck {
  // Safe to call from every server on any schedule: a domain is looked up at most once a
  // day, and a row another server changed meanwhile is left to it.
  runOnce(): Promise<SsoDomainRecheckSummary>;
}

const TOKEN_BYTES = 32;
// Answered misses in a row before a domain loses its proof.
export const SSO_DOMAIN_STRIKES = 3;
// Enough of the HMAC to tie lines together; it says nothing of the domain.
const DOMAIN_KEY_HEX = 16;
const DEFAULT_PAGE = 100;
const DEFAULT_MAX_PER_RUN = 500;

class Refused extends Error {
  readonly code: AuthErrorCode;
  constructor(code: AuthErrorCode) {
    super(code);
    this.code = code;
  }
}

function repositoryOf(deps: SharedDeps): SsoDomainRepository {
  return deps.repository ?? createSsoDomainRepository(deps);
}

const domainKeyOf = (keys: AuthKeys, domain: string) =>
  keys.mac('rate', ['sso_domain', domain]).toString('hex').slice(0, DOMAIN_KEY_HEX);

// The flag client already answers its safe value on a provider failure; a throw here is
// read the same way, as off.
async function flagOn(flag: TeamSsoFlag, organizationId: OrganizationId, userId?: UserId) {
  try {
    return await flag.isOn(
      'auth.team_sso',
      userId === undefined ? { organizationId } : { organizationId, userId },
    );
  } catch {
    return false;
  }
}

// The whole record, trimmed, against the stored hash, so a partial or padded token fails.
function holdsToken(records: readonly string[], tokenHash: Buffer): boolean {
  let found = false;
  for (const record of records) {
    if (constantTimeEqual(sha256(record.trim()), tokenHash)) found = true;
  }
  return found;
}

async function lookup(resolver: TxtResolver, domain: string): Promise<TxtLookup> {
  try {
    return await resolver.lookupTxt(ssoTxtName(domain));
  } catch {
    return { kind: 'unknown' };
  }
}

// A bare top level domain such as com fails the domain rule for want of a dot, but naming it
// a public suffix tells the person why.
function topLevelSuffix(policy: SsoDomainPolicy, input: unknown): boolean {
  if (typeof input !== 'string') return false;
  const probe = normalizeSsoDomain(`x.${input.trim()}`);
  if (probe === null) return false;
  const label = probe.slice(2);
  return !label.includes('.') && policy.refusal(label) === 'public_suffix';
}

// 23505 raw inside the work, or mapped by the pool. The only unique index this update can
// reach is the one that lets a domain be verified by one organization at a time.
function uniqueViolation(error: unknown): boolean {
  if (error instanceof DbError) return error.code === 'DB_UNIQUE_VIOLATION';
  return Reflect.get(Object(error), 'code') === '23505';
}

function entitled(tier: unknown): boolean {
  return hasFeature(storedTier(tier), 'org.sso_saml');
}

// Against the membership and plan as stored now, not as the guard saw them at the start of
// the request.
async function authorize(ops: SsoDomainOps, ctx: AccessContext): Promise<void> {
  const member = await ops.member(ctx.userId);
  if (member === null) throw new Refused('AUTH_FORBIDDEN');
  const permissions = storedPermissions(member.role, member.defaultProjectRole);
  if (!permissions.includes('org.manage_settings')) throw new Refused('AUTH_FORBIDDEN');
  if (!entitled(await ops.planTier())) throw new Refused('AUTH_SSO_DISABLED');
}

function viewOf(row: StoredSsoDomain): SsoDomainView {
  return Object.freeze({
    domainId: idOf('ssd', row.id),
    connectionId: idOf('ssc', row.connectionId),
    domain: row.domain,
    verifiedAt: row.verifiedAt,
    lastCheckedAt: row.lastCheckedAt,
    failedChecks: row.failedChecks,
  });
}

type Ids = Parameters<typeof idFields>[0];

// After the commit. Mail and the audit sink are each tried on their own, and a failure of
// either is logged and never undoes the change.
function announcer(deps: SharedDeps) {
  return async (
    kind: 'claimed' | 'verified' | 'unverified',
    organizationId: OrganizationId,
    row: StoredSsoDomain,
    owners: readonly string[],
    actorUserId: UserId | null,
    ids: Ids,
  ): Promise<void> => {
    const domainId = idOf('ssd', row.id);
    const event: AuthEvent = {
      type: `sso.domain_${kind}`,
      organizationId,
      connectionId: idOf('ssc', row.connectionId),
      domainId,
      domainKey: domainKeyOf(deps.keys, row.domain),
      actorUserId,
      at: row.updatedAt,
    };
    try {
      await deps.events.record(Object.freeze(event));
    } catch {
      quietWarn(deps.logger, 'auth.sso_domain_event_failed', idFields(ids));
    }
    const notice: SsoDomainNotice = Object.freeze({
      kind: `sso_domain_${kind}`,
      organizationId,
      domainId,
      domain: row.domain,
      at: row.updatedAt,
    });
    for (const to of owners) {
      try {
        await deps.mailer.sendSsoDomainNotice(to, notice);
      } catch {
        quietWarn(deps.logger, 'auth.sso_domain_notice_failed', idFields(ids));
      }
    }
  };
}

export function createSsoDomains(deps: SsoDomainsDeps): SsoDomains {
  const repository = repositoryOf(deps);
  const random = deps.random ?? ((n: number) => randomBytes(n));
  const announce = announcer(deps);

  function settle<T>(
    error: unknown,
    ids: Ids,
    event: string,
    domainKey?: string,
  ): Result<T, AuthError> {
    const fields = { ...idFields(ids), ...(domainKey === undefined ? {} : { domainKey }) };
    if (error instanceof Refused) {
      quietInfo(deps.logger, event, { ...fields, outcome: error.code });
      return fail(new AuthError(error.code));
    }
    if (error instanceof AuthError) {
      quietInfo(deps.logger, event, { ...fields, outcome: error.code });
      return fail(error);
    }
    quietWarn(deps.logger, event, { ...fields, outcome: 'AUTH_UNAVAILABLE' });
    return fail(error);
  }

  // Before anything is read or written: the flag, then a recent step up.
  async function gate(ctx: AccessContext): Promise<void> {
    if (!(await flagOn(deps.flag, ctx.organizationId, ctx.userId))) {
      throw new Refused('AUTH_SSO_DISABLED');
    }
    const recent = await repository.recentAuth(ctx);
    if (!recent.ok) throw recent.error;
  }

  return Object.freeze({
    async claimDomain(ctx: AccessContext, connectionId: SsoConnectionId, input: string) {
      const ids: Ids = {
        organizationId: ['org', ctx.organizationId],
        userId: ['usr', ctx.userId],
        connectionId: ['ssc', connectionId],
      };
      const event = 'auth.sso_domain_claim_refused';
      const domain = normalizeSsoDomain(input);
      const domainKey = domain === null ? undefined : domainKeyOf(deps.keys, domain);
      try {
        await gate(ctx);
        if (domain === null || asId('ssc', connectionId) === null) {
          throw new Refused(
            topLevelSuffix(deps.policy, input) ? 'AUTH_SSO_DOMAIN_REFUSED' : 'AUTH_INPUT_INVALID',
          );
        }
        await repository.inOrganization(ctx.organizationId, ctx.userId, (ops) =>
          authorize(ops, ctx),
        );
        if (deps.policy.refusal(domain) !== null) throw new Refused('AUTH_SSO_DOMAIN_REFUSED');
        if (await repository.verifiedElsewhere(ctx.organizationId, domain)) {
          throw new Refused('AUTH_SSO_DOMAIN_TAKEN');
        }
        const token = Buffer.from(random(TOKEN_BYTES)).toString('base64url');
        const tokenHash = sha256(token);
        const done = await repository.inOrganization(
          ctx.organizationId,
          ctx.userId,
          async (ops) => {
            await authorize(ops, ctx);
            if (!(await ops.connectionExists(connectionId))) throw new Refused('AUTH_NOT_FOUND');
            // Locked first, so a second claim of the same domain waits and then sees this one.
            let row = await ops.lockDomainByName(domain);
            row ??= await ops.insertDomain({ connectionId, domain, tokenHash });
            // A claim that committed between the lock and the insert.
            row ??= await ops.lockDomainByName(domain);
            if (row === null) throw new Error('claimed domain row vanished');
            if (row.verifiedAt !== null) {
              // Moving a proved domain changes which IdP is trusted; that is a connection
              // change with its own checks, not a claim.
              if (row.connectionId !== connectionId) throw new Refused('AUTH_INPUT_INVALID');
              return { row, issued: false, owners: [] };
            }
            if (!row.tokenHash.equals(tokenHash) || row.connectionId !== connectionId) {
              row = await ops.reissueToken(row.id, connectionId, tokenHash);
            }
            return { row, issued: true, owners: await ops.ownerAddresses() };
          },
        );
        const domainId = idOf('ssd', done.row.id);
        const claimIds: Ids = { ...ids, domainId: ['ssd', domainId] };
        if (done.issued) {
          quietInfo(deps.logger, 'auth.sso_domain_claimed', {
            ...idFields(claimIds),
            domainKey: domainKeyOf(deps.keys, domain),
          });
          await announce(
            'claimed',
            ctx.organizationId,
            done.row,
            done.owners,
            ctx.userId,
            claimIds,
          );
        }
        return ok(
          Object.freeze({
            domainId,
            txtName: ssoTxtName(domain),
            txtValue: done.issued ? token : null,
            verified: !done.issued,
          }),
        );
      } catch (error) {
        return settle(error, ids, event, domainKey);
      }
    },

    async verifyDomain(ctx: AccessContext, domainId: SsoDomainId) {
      const ids: Ids = {
        organizationId: ['org', ctx.organizationId],
        userId: ['usr', ctx.userId],
        domainId: ['ssd', domainId],
      };
      const event = 'auth.sso_domain_verify_refused';
      let domainKey: string | undefined;
      try {
        await gate(ctx);
        if (asId('ssd', domainId) === null) throw new Refused('AUTH_INPUT_INVALID');
        const claim = await repository.inOrganization(
          ctx.organizationId,
          ctx.userId,
          async (ops) => {
            await authorize(ops, ctx);
            const row = await ops.domainById(domainId);
            if (row === null) throw new Refused('AUTH_NOT_FOUND');
            return row;
          },
        );
        domainKey = domainKeyOf(deps.keys, claim.domain);
        // Counted only for a caller who may verify, and before the query it pays for.
        await deps.limiter.reserve('sso_domain_verify', [ctx.organizationId]);
        const answer = await lookup(deps.resolver, claim.domain);
        if (answer.kind === 'unknown') {
          quietWarn(deps.logger, 'auth.sso_domain_lookup_unknown', { ...idFields(ids), domainKey });
          throw new AuthError('AUTH_UNAVAILABLE');
        }
        if (!holdsToken(answer.records, claim.tokenHash)) {
          throw new Refused('AUTH_SSO_DOMAIN_UNVERIFIED');
        }
        const done = await repository.inOrganization(
          ctx.organizationId,
          ctx.userId,
          async (ops) => {
            await authorize(ops, ctx);
            const before = await ops.domainById(domainId);
            if (before === null) throw new Refused('AUTH_NOT_FOUND');
            let row: StoredSsoDomain | null;
            try {
              row = await ops.markVerified(before.id, claim.tokenHash);
            } catch (error) {
              if (uniqueViolation(error)) throw new Refused('AUTH_SSO_DOMAIN_TAKEN');
              throw error;
            }
            // A repeat claim replaced the token while the lookup ran.
            if (row === null) throw new Refused('AUTH_SSO_DOMAIN_UNVERIFIED');
            const fresh = before.verifiedAt === null;
            return { row, fresh, owners: fresh ? await ops.ownerAddresses() : [] };
          },
        );
        quietInfo(deps.logger, 'auth.sso_domain_verified', { ...idFields(ids), domainKey });
        if (done.fresh) {
          await announce('verified', ctx.organizationId, done.row, done.owners, ctx.userId, ids);
        }
        return ok(viewOf(done.row));
      } catch (error) {
        return settle(error, ids, event, domainKey);
      }
    },
  } satisfies SsoDomains);
}

interface Tally {
  checked: number;
  confirmed: number;
  missed: number;
  unknown: number;
  unverified: number;
  skipped: number;
  failed: number;
  more: boolean;
}

export function createSsoDomainRecheck(deps: SsoDomainRecheckDeps): SsoDomainRecheck {
  const repository = repositoryOf(deps);
  const pageSize = deps.pageSize ?? DEFAULT_PAGE;
  const maxPerRun = deps.maxPerRun ?? DEFAULT_MAX_PER_RUN;
  const announce = announcer(deps);

  async function checkOne(ref: VerifiedSsoDomainRef, tally: Tally): Promise<void> {
    const { organizationId } = ref;
    const domainKey = domainKeyOf(deps.keys, ref.domain);
    const orgIds: Ids = { organizationId: ['org', organizationId] };
    // Flag off or the plan lost: nothing is checked and nothing is changed, so turning
    // either back on finds the domain as it was.
    if (!(await flagOn(deps.flag, organizationId))) {
      tally.skipped += 1;
      return;
    }
    try {
      const row = await repository.inOrganization(organizationId, null, async (ops) =>
        entitled(await ops.planTier()) ? ops.dueDomain(ref.domain) : null,
      );
      if (row === null) {
        tally.skipped += 1;
        return;
      }
      tally.checked += 1;
      const ids: Ids = {
        ...orgIds,
        domainId: ['ssd', row.id],
        connectionId: ['ssc', row.connectionId],
      };
      const answer = await lookup(deps.resolver, row.domain);
      if (answer.kind === 'unknown') {
        // Not a strike, and the row is left as it was, so the next run asks again.
        tally.unknown += 1;
        quietInfo(deps.logger, 'auth.sso_domain_rechecked', {
          ...idFields(ids),
          domainKey,
          outcome: 'unknown',
          failedChecks: row.failedChecks,
        });
        return;
      }
      const found = holdsToken(answer.records, row.tokenHash);
      const done = await repository.inOrganization(organizationId, null, async (ops) => {
        const updated = found
          ? await ops.recordFound(row.id, row.tokenHash, row.failedChecks)
          : await ops.recordMiss(row.id, row.tokenHash, row.failedChecks, SSO_DOMAIN_STRIKES);
        if (updated === null) return null;
        const lost = updated.verifiedAt === null;
        return { updated, lost, owners: lost ? await ops.ownerAddresses() : [] };
      });
      if (done === null) {
        tally.skipped += 1;
        return;
      }
      if (found) tally.confirmed += 1;
      else tally.missed += 1;
      quietInfo(deps.logger, 'auth.sso_domain_rechecked', {
        ...idFields(ids),
        domainKey,
        outcome: found ? 'found' : 'missed',
        failedChecks: done.updated.failedChecks,
      });
      if (done.lost) {
        tally.unverified += 1;
        quietWarn(deps.logger, 'auth.sso_domain_unverified', { ...idFields(ids), domainKey });
        await announce('unverified', organizationId, done.updated, done.owners, null, ids);
      }
    } catch {
      tally.failed += 1;
      quietWarn(deps.logger, 'auth.sso_domain_recheck_failed', { ...idFields(orgIds), domainKey });
    }
  }

  return Object.freeze({
    async runOnce(): Promise<SsoDomainRecheckSummary> {
      const tally: Tally = {
        checked: 0,
        confirmed: 0,
        missed: 0,
        unknown: 0,
        unverified: 0,
        skipped: 0,
        failed: 0,
        more: false,
      };
      let after: VerifiedSsoDomainRef | null = null;
      walk: for (;;) {
        let page: readonly VerifiedSsoDomainRef[];
        try {
          page = await repository.verifiedPage(after, pageSize);
        } catch {
          tally.failed += 1;
          quietWarn(deps.logger, 'auth.sso_domain_recheck_failed', {});
          break;
        }
        for (const ref of page) {
          if (tally.checked >= maxPerRun) {
            tally.more = true;
            break walk;
          }
          await checkOne(ref, tally);
        }
        const last = page.at(-1);
        if (page.length < pageSize || last === undefined) break;
        after = last;
      }
      quietInfo(deps.logger, 'auth.sso_domain_recheck_run', {
        checked: tally.checked,
        confirmed: tally.confirmed,
        missed: tally.missed,
        unknown: tally.unknown,
        unverified: tally.unverified,
        skipped: tally.skipped,
        failed: tally.failed,
      });
      return Object.freeze({ ...tally });
    },
  });
}

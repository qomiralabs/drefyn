import { createHash, randomBytes } from 'node:crypto';
import { DbError, newId, type RateWindowRequest, type WindowCount } from '@drefyn/db';
import { idOf, type OrganizationId, type UserId } from '@drefyn/tenancy';
import type { Tier } from '@drefyn/entitlements';
import {
  AuthError,
  createRateLimiter,
  createSsoDomainPolicy,
  createSsoDomains,
  createSsoDomainRecheck,
  deriveAuthKeys,
  parseAuthConfig,
  parsePublicSuffixList,
  type AuthEvent,
  type AuthEventSink,
  type SsoConnectionId,
  type SsoDomainNotice,
  type SsoDomainNoticeMailer,
  type SsoDomainOps,
  type SsoDomainRepository,
  type SsoDomainsDeps,
  type StoredSsoDomain,
  type TeamSsoFlag,
  type TxtLookup,
  type TxtResolver,
  type VerifiedSsoDomainRef,
} from '../src/index.ts';
import { grantAccess } from '../src/access.ts';
import type { OrgRole } from '../src/permissions.ts';
import { validEnv } from './support.ts';
import { SESSION, capturingLogger } from './session-fixtures.ts';

const DAY_MS = 86_400_000;

// A small snapshot in the real file's format, so rule parsing is exercised without the
// whole list in every unit test. The real list has its own test.
export const SMALL_PSL = [
  '// This Source Code Form is subject to the terms of the Mozilla Public',
  '// ===BEGIN ICANN DOMAINS===',
  'com',
  'uk',
  'co.uk',
  'ck',
  '*.ck',
  '!www.ck',
  'cn',
  '公司.cn',
  '// ===END ICANN DOMAINS===',
  '// ===BEGIN PRIVATE DOMAINS===',
  'io',
  'github.io',
  'example',
  'net',
  'org',
  '',
].join('\n');

interface Org {
  tier: Tier;
  readonly members: Map<UserId, { role: OrgRole; defaultProjectRole: string | null }>;
  readonly owners: string[];
  readonly connections: Set<string>;
}

interface Row {
  readonly organizationId: OrganizationId;
  readonly id: string;
  connectionId: string;
  readonly domain: string;
  tokenHash: Buffer;
  verifiedAt: Date | null;
  lastCheckedAt: Date | null;
  failedChecks: number;
}

const view = (row: Row): StoredSsoDomain =>
  Object.freeze({
    id: row.id,
    connectionId: row.connectionId,
    domain: row.domain,
    tokenHash: Buffer.from(row.tokenHash),
    verifiedAt: row.verifiedAt,
    lastCheckedAt: row.lastCheckedAt,
    failedChecks: row.failedChecks,
  });

// An in memory stand in for the SSO domain tables under their policies: each organization
// sees only its own rows, (organization, domain) is unique, a domain is verified by one
// organization at most, and a failed transaction leaves nothing behind.
export function fakeRepository() {
  const orgs = new Map<OrganizationId, Org>();
  let rows: Row[] = [];
  let clock = new Date('2026-11-14T09:00:00.000Z');
  let writes = 0;
  let recent = true;
  let failNext: Error | null = null;
  const transactions: { organizationId: OrganizationId; actor: UserId | null }[] = [];

  const due = (row: Row) =>
    row.lastCheckedAt === null || clock.getTime() - row.lastCheckedAt.getTime() >= DAY_MS;

  function orgOf(id: OrganizationId): Org {
    const org = orgs.get(id);
    if (org === undefined) throw new Error('no such organization in the fake');
    return org;
  }

  function opsFor(organizationId: OrganizationId): SsoDomainOps {
    const mine = () => rows.filter((r) => r.organizationId === organizationId);
    const write = () => {
      writes += 1;
    };
    const byId = (id: string) => mine().find((r) => r.id === id);
    return {
      member: (userId) => {
        const m = orgOf(organizationId).members.get(userId);
        return Promise.resolve(
          m === undefined ? null : { role: m.role, defaultProjectRole: m.defaultProjectRole },
        );
      },
      planTier: () => Promise.resolve(orgOf(organizationId).tier),
      connectionExists: (connectionId) =>
        Promise.resolve(orgOf(organizationId).connections.has(connectionId)),
      lockDomainByName: (domain) => {
        const row = mine().find((r) => r.domain === domain);
        return Promise.resolve(row === undefined ? null : view(row));
      },
      domainById: (id) => {
        const row = byId(id);
        return Promise.resolve(row === undefined ? null : view(row));
      },
      insertDomain: ({ connectionId, domain, tokenHash }) => {
        if (mine().some((r) => r.domain === domain)) return Promise.resolve(null);
        write();
        const row: Row = {
          organizationId,
          id: newId('ssd'),
          connectionId,
          domain,
          tokenHash: Buffer.from(tokenHash),
          verifiedAt: null,
          lastCheckedAt: null,
          failedChecks: 0,
        };
        rows.push(row);
        return Promise.resolve(view(row));
      },
      reissueToken: (id, connectionId, tokenHash) => {
        const row = byId(id);
        if (row === undefined) throw new Error('reissue of a missing row');
        write();
        row.connectionId = connectionId;
        row.tokenHash = Buffer.from(tokenHash);
        row.failedChecks = 0;
        return Promise.resolve(view(row));
      },
      markVerified: (id, tokenHash) => {
        const row = byId(id);
        if (row === undefined || !row.tokenHash.equals(tokenHash)) return Promise.resolve(null);
        const holder = rows.find(
          (r) => r.domain === row.domain && r.verifiedAt !== null && r !== row,
        );
        if (holder !== undefined) {
          return Promise.reject(
            new DbError('DB_UNIQUE_VIOLATION', 'unique constraint sso_domains_verified_domain_key'),
          );
        }
        write();
        row.verifiedAt ??= clock;
        row.lastCheckedAt = clock;
        row.failedChecks = 0;
        return Promise.resolve(view(row));
      },
      dueDomain: (domain) => {
        const row = mine().find((r) => r.domain === domain && r.verifiedAt !== null && due(r));
        return Promise.resolve(row === undefined ? null : view(row));
      },
      recordFound: (id, tokenHash, failedChecks) => {
        const row = byId(id);
        if (
          row === undefined ||
          row.verifiedAt === null ||
          !row.tokenHash.equals(tokenHash) ||
          row.failedChecks !== failedChecks ||
          !due(row)
        ) {
          return Promise.resolve(null);
        }
        write();
        row.failedChecks = 0;
        row.lastCheckedAt = clock;
        return Promise.resolve(view(row));
      },
      recordMiss: (id, tokenHash, failedChecks, strikes) => {
        const row = byId(id);
        if (
          row === undefined ||
          row.verifiedAt === null ||
          !row.tokenHash.equals(tokenHash) ||
          row.failedChecks !== failedChecks ||
          !due(row)
        ) {
          return Promise.resolve(null);
        }
        write();
        row.failedChecks += 1;
        row.lastCheckedAt = clock;
        if (row.failedChecks >= strikes) row.verifiedAt = null;
        return Promise.resolve(view(row));
      },
      ownerAddresses: () => Promise.resolve([...orgOf(organizationId).owners]),
    };
  }

  const repository: SsoDomainRepository = {
    recentAuth: () =>
      Promise.resolve(
        recent
          ? { ok: true, value: undefined }
          : { ok: false, error: new AuthError('AUTH_RECENT_AUTH_REQUIRED') },
      ),
    verifiedElsewhere: (organizationId, domain) =>
      Promise.resolve(
        rows.some(
          (r) =>
            r.domain === domain && r.verifiedAt !== null && r.organizationId !== organizationId,
        ),
      ),
    verifiedPage: (after, limit) => {
      const key = (r: VerifiedSsoDomainRef) => `${r.organizationId} ${r.domain}`;
      const listed = rows
        .filter((r) => r.verifiedAt !== null)
        .map((r) => ({ organizationId: r.organizationId, domain: r.domain }))
        .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
        .filter((r) => after === null || key(r) > key(after))
        .slice(0, limit);
      return Promise.resolve(listed);
    },
    async inOrganization(organizationId, actor, work) {
      transactions.push({ organizationId, actor });
      if (failNext !== null) {
        const error = failNext;
        failNext = null;
        throw error;
      }
      const before = rows.map((r) => ({ ...r }));
      const writesBefore = writes;
      try {
        return await work(opsFor(organizationId));
      } catch (error) {
        rows = before;
        writes = writesBefore;
        throw error;
      }
    },
  };

  return {
    repository,
    transactions,
    get writes() {
      return writes;
    },
    get rows(): readonly Row[] {
      return rows;
    },
    get now() {
      return clock;
    },
    addOrganization(
      organizationId: OrganizationId,
      options: { tier?: Tier; owners?: string[]; connections?: string[] } = {},
    ) {
      orgs.set(organizationId, {
        tier: options.tier ?? 'enterprise',
        members: new Map(),
        owners: options.owners ?? ['owner@example.com'],
        connections: new Set(options.connections ?? []),
      });
    },
    addMember(
      organizationId: OrganizationId,
      userId: UserId,
      role: OrgRole,
      defaultProjectRole: string | null = null,
    ) {
      orgOf(organizationId).members.set(userId, { role, defaultProjectRole });
    },
    setTier(organizationId: OrganizationId, tier: Tier) {
      orgOf(organizationId).tier = tier;
    },
    setRecent(value: boolean) {
      recent = value;
    },
    failNextTransaction(error: Error) {
      failNext = error;
    },
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
    // Writes a verified row directly, as a finished verification would leave it.
    seedVerified(
      organizationId: OrganizationId,
      connectionId: string,
      domain: string,
      token: string,
    ) {
      const row: Row = {
        organizationId,
        id: newId('ssd'),
        connectionId,
        domain,
        tokenHash: sha256Of(token),
        verifiedAt: clock,
        lastCheckedAt: clock,
        failedChecks: 0,
      };
      rows.push(row);
      return row;
    },
  };
}

export type FakeRepository = ReturnType<typeof fakeRepository>;

// A direct digest, so the test does not lean on the code it checks.
export const sha256Of = (text: string) => createHash('sha256').update(text).digest();

// Answers by TXT name. A name with no entry is answered with no records, as NXDOMAIN is.
export function fakeResolver() {
  const answers = new Map<string, TxtLookup | (() => Promise<TxtLookup>)>();
  const calls: string[] = [];
  const resolver: TxtResolver = {
    lookupTxt(name) {
      calls.push(name);
      const answer = answers.get(name);
      if (answer === undefined) return Promise.resolve({ kind: 'answer', records: [] });
      return typeof answer === 'function' ? answer() : Promise.resolve(answer);
    },
  };
  return {
    resolver,
    calls,
    answer(name: string, records: readonly string[]) {
      answers.set(name, { kind: 'answer', records });
    },
    unknown(name: string) {
      answers.set(name, { kind: 'unknown' });
    },
    script(name: string, next: () => Promise<TxtLookup>) {
      answers.set(name, next);
    },
  };
}

// Counts reservations per key and window the way the database does, so the real limiter and
// the configured limit decide.
export function memoryReserve() {
  const counts = new Map<string, number>();
  const reserve = (_db: unknown, request: RateWindowRequest): Promise<readonly WindowCount[]> =>
    Promise.resolve(
      request.windowSeconds.map((windowSeconds) => {
        const key = `${request.bucket}:${request.keyHmac.toString('hex')}:${String(windowSeconds)}`;
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        return { windowSeconds, count, retryAfterSeconds: windowSeconds };
      }),
    );
  return { reserve, counts };
}

export function recordingMailer(): SsoDomainNoticeMailer & {
  sent: { to: string; notice: SsoDomainNotice }[];
  failing: boolean;
} {
  const sent: { to: string; notice: SsoDomainNotice }[] = [];
  return {
    sent,
    failing: false,
    sendSsoDomainNotice(to, notice) {
      if (this.failing) return Promise.reject(new Error('smtp refused'));
      sent.push({ to, notice });
      return Promise.resolve();
    },
  };
}

export function recordingEvents(): AuthEventSink & { events: AuthEvent[]; failing: boolean } {
  const events: AuthEvent[] = [];
  return {
    events,
    failing: false,
    record(event) {
      if (this.failing) return Promise.reject(new Error('sink down'));
      events.push(event);
      return Promise.resolve();
    },
  };
}

export function fakeFlag(initial = true) {
  const off = new Set<string>();
  let on = initial;
  let throws = false;
  const calls: { name: string; organizationId: string; userId?: string }[] = [];
  const flag: TeamSsoFlag = {
    isOn(name, ctx) {
      calls.push({
        name,
        organizationId: ctx.organizationId,
        ...(ctx.userId === undefined ? {} : { userId: ctx.userId }),
      });
      if (throws) return Promise.reject(new Error('provider down'));
      return Promise.resolve(on && !off.has(ctx.organizationId));
    },
  };
  return {
    flag,
    calls,
    set(value: boolean) {
      on = value;
    },
    offFor(organizationId: string) {
      off.add(organizationId);
    },
    throwing() {
      throws = true;
    },
  };
}

export const ORG_A: OrganizationId = idOf('org', '01890a5d-ac96-774b-bcce-b302099a8101');
export const ORG_B: OrganizationId = idOf('org', '01890a5d-ac96-774b-bcce-b302099a8102');
export const ADMIN: UserId = idOf('usr', '01890a5d-ac96-774b-bcce-b302099a8111');
export const MEMBER: UserId = idOf('usr', '01890a5d-ac96-774b-bcce-b302099a8112');
export const ADMIN_B: UserId = idOf('usr', '01890a5d-ac96-774b-bcce-b302099a8113');
export const CONNECTION_A: SsoConnectionId = idOf('ssc', '01890a5d-ac96-774b-bcce-b302099a8121');
export const CONNECTION_A2: SsoConnectionId = idOf('ssc', '01890a5d-ac96-774b-bcce-b302099a8123');
export const CONNECTION_B: SsoConnectionId = idOf('ssc', '01890a5d-ac96-774b-bcce-b302099a8122');

export const accessFor = (
  organizationId: OrganizationId,
  userId: UserId,
  role: OrgRole = 'admin',
  tier: Tier = 'enterprise',
) =>
  grantAccess({
    organizationId,
    userId,
    sessionId: SESSION,
    role,
    defaultProjectRole: null,
    tier,
    authenticatedAt: new Date('2026-11-14T08:59:00.000Z'),
  });

// Everything a unit test needs, wired the way the dashboard will wire it.
export function domainWorld(
  options: { extraFreeMail?: readonly string[]; deps?: Partial<SsoDomainsDeps> } = {},
) {
  const repo = fakeRepository();
  repo.addOrganization(ORG_A, {
    connections: [CONNECTION_A, CONNECTION_A2],
    owners: ['ada@acme.test', 'grace@acme.test'],
  });
  repo.addOrganization(ORG_B, { connections: [CONNECTION_B], owners: ['bo@other.test'] });
  repo.addMember(ORG_A, ADMIN, 'admin');
  repo.addMember(ORG_A, MEMBER, 'member', 'editor');
  repo.addMember(ORG_B, ADMIN_B, 'owner');
  const dns = fakeResolver();
  const { logger, lines } = capturingLogger();
  const mailer = recordingMailer();
  const events = recordingEvents();
  const flags = fakeFlag();
  const memory = memoryReserve();
  const config = parseAuthConfig(validEnv(randomBytes(32).toString('base64url')));
  const keys = deriveAuthKeys(randomBytes(32));
  const limiter = createRateLimiter({
    db: {} as never,
    keys,
    limits: config.rateLimits,
    reserve: memory.reserve,
  });
  const policy = createSsoDomainPolicy({
    publicSuffixes: parsePublicSuffixList(SMALL_PSL),
    extraFreeMail: options.extraFreeMail ?? [],
  });
  const deps: SsoDomainsDeps = {
    repository: repo.repository,
    keys,
    limiter,
    resolver: dns.resolver,
    policy,
    flag: flags.flag,
    logger,
    mailer,
    events,
    ...options.deps,
  };
  const domains = createSsoDomains(deps);
  const recheck = createSsoDomainRecheck({
    repository: repo.repository,
    keys,
    resolver: dns.resolver,
    flag: flags.flag,
    logger,
    mailer,
    events,
  });
  return { repo, dns, lines, mailer, events, flags, memory, domains, recheck, keys, policy };
}

export type DomainWorld = ReturnType<typeof domainWorld>;

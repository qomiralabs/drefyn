import { createHash, randomBytes } from 'node:crypto';
import { idOf } from '@drefyn/tenancy';
import { beforeAll, expect, it } from 'vitest';
import {
  createSsoDomainPolicy,
  createSsoDomainRecheck,
  createSsoDomains,
  createRateLimiter,
  loadPublicSuffixList,
  type SsoConnectionId,
  type SsoDomainClaim,
} from '../../src/index.ts';
import { fakeFlag, fakeResolver, recordingEvents, recordingMailer } from '../sso-domain-fakes.ts';
import { newOrg, signIn, type Org } from './support/api-keys.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';

const fresh = harness();
let h: Harness;

const unique = () => `d${randomBytes(5).toString('hex')}.test`;

async function connection(org: Org): Promise<SsoConnectionId> {
  const id = await h.sql(
    `insert into app.sso_connections (organization_id, protocol, display_name, idempotency_key)
     values ('${org.organizationId}', 'oidc', 'Okta', '${randomBytes(8).toString('hex')}')
     returning id;`,
  );
  return idOf('ssc', id.trim().split('\n')[0] ?? '');
}

async function world() {
  const dns = fakeResolver();
  const mailer = recordingMailer();
  const events = recordingEvents();
  const flags = fakeFlag();
  const limiter = createRateLimiter({
    db: h.authDb,
    keys: h.config.keys,
    limits: h.config.rateLimits,
  });
  const policy = createSsoDomainPolicy({
    publicSuffixes: await loadPublicSuffixList(),
    extraFreeMail: [],
  });
  const logger = { warn: () => undefined, info: () => undefined };
  const common = { db: h.db, authDb: h.authDb, keys: h.config.keys, logger, mailer, events };
  const domains = createSsoDomains({
    ...common,
    limiter,
    resolver: dns.resolver,
    policy,
    flag: flags.flag,
  });
  const recheck = createSsoDomainRecheck({ ...common, resolver: dns.resolver, flag: flags.flag });
  return { dns, mailer, events, domains, recheck };
}

type World = Awaited<ReturnType<typeof world>>;

async function claim(w: World, org: Org, conn: SsoConnectionId, domain: string) {
  const made = await w.domains.claimDomain(org.owner, conn, domain);
  if (!made.ok) throw made.error;
  return made.value;
}

async function verify(w: World, org: Org, made: SsoDomainClaim) {
  w.dns.answer(made.txtName, [made.txtValue ?? '']);
  return w.domains.verifyDomain(org.owner, made.domainId);
}

const rowOf = async (domainId: string) =>
  h.sql(
    `select domain, organization_id, encode(txt_token_hash, 'hex'), verified_at is not null,
            failed_checks
       from app.sso_domains where id = '${domainId}';`,
  );

describeWithStack('SSO domains on Postgres', () => {
  beforeAll(async () => {
    h = await fresh();
  });

  it('claims once per organization and domain, and stores only the token hash', async () => {
    const w = await world();
    const org = await newOrg(h);
    const conn = await connection(org);
    const domain = unique();
    const first = await claim(w, org, conn, domain);
    const again = await claim(w, org, conn, domain.toUpperCase());
    expect(again.domainId).toBe(first.domainId);
    const count = await h.sql(
      `select count(*) from app.sso_domains where organization_id = '${org.organizationId}';`,
    );
    expect(count.trim()).toBe('1');
    const hash = createHash('sha256')
      .update(again.txtValue ?? '')
      .digest('hex');
    expect((await rowOf(first.domainId)).trim()).toBe(
      `${domain}|${org.organizationId}|${hash}|f|0`,
    );
    const dump = await h.sql(`select row_to_json(d)::text from app.sso_domains d;`);
    expect(dump).not.toContain(again.txtValue);
  });

  it('verifies with the token in DNS, and never for another organization', async () => {
    const w = await world();
    const a = await newOrg(h);
    const b = await newOrg(h);
    const connA = await connection(a);
    const connB = await connection(b);
    const domain = unique();
    const claimA = await claim(w, a, connA, domain);
    // Any number of organizations may claim; only one may hold it verified.
    const claimB = await claim(w, b, connB, domain);
    const verified = await verify(w, a, claimA);
    expect(verified.ok).toBe(true);
    const taken = await verify(w, b, claimB);
    expect(taken.ok ? null : taken.error.code).toBe('AUTH_SSO_DOMAIN_TAKEN');
    expect((await rowOf(claimB.domainId)).trim().endsWith('|f|0')).toBe(true);
    // A fresh claim by the other organization is refused outright now.
    const again = await w.domains.claimDomain(b.owner, connB, domain);
    expect(again.ok ? null : again.error.code).toBe('AUTH_SSO_DOMAIN_TAKEN');
    // Organization B cannot reach A's row by its id.
    const cross = await w.domains.verifyDomain(b.owner, claimA.domainId);
    expect(cross.ok ? null : cross.error.code).toBe('AUTH_NOT_FOUND');
  });

  it('keeps a subdomain apart from its parent', async () => {
    const w = await world();
    const a = await newOrg(h);
    const b = await newOrg(h);
    const domain = unique();
    const parent = await claim(w, a, await connection(a), domain);
    expect((await verify(w, a, parent)).ok).toBe(true);
    const child = await claim(w, b, await connection(b), `eu.${domain}`);
    expect((await verify(w, b, child)).ok).toBe(true);
  });

  it('unverifies after three answered misses on the daily recheck, then lets another verify', async () => {
    const w = await world();
    const a = await newOrg(h);
    const b = await newOrg(h);
    const domain = unique();
    const made = await claim(w, a, await connection(a), domain);
    expect((await verify(w, a, made)).ok).toBe(true);
    w.dns.answer(made.txtName, ['not the token']);
    const age = async () =>
      h.sql(
        `update app.sso_domains set last_checked_at = now() - interval '25 hours'
          where id = '${made.domainId}';`,
      );
    for (let day = 1; day <= 3; day += 1) {
      await age();
      const run = await w.recheck.runOnce();
      expect(run.failed).toBe(0);
    }
    expect((await rowOf(made.domainId)).trim().endsWith('|f|3')).toBe(true);
    expect(w.mailer.sent.map((m) => m.notice.kind)).toContain('sso_domain_unverified');
    expect(w.events.events.map((e) => e.type)).toContain('sso.domain_unverified');
    // Not due again within a day of a check, so a second run makes no lookup.
    const lookups = w.dns.calls.length;
    await w.recheck.runOnce();
    expect(w.dns.calls.length).toBe(lookups);

    const theirs = await claim(w, b, await connection(b), domain);
    expect((await verify(w, b, theirs)).ok).toBe(true);
  });

  it('writes nothing for a member without org.manage_settings', async () => {
    const w = await world();
    const org = await newOrg(h);
    const conn = await connection(org);
    const { session, cookie, sessions } = await signIn(h);
    await h.sql(
      `insert into app.memberships (organization_id, user_id, role)
       values ('${org.organizationId}', '${session.userId}', 'member');`,
    );
    const member = await sessions.resolveAccess(cookie, org.slug);
    if (member.kind !== 'ok') throw new Error(`member did not resolve: ${member.kind}`);
    const refused = await w.domains.claimDomain(member.access, conn, unique());
    expect(refused.ok ? null : refused.error.code).toBe('AUTH_FORBIDDEN');
    const count = await h.sql(
      `select count(*) from app.sso_domains where organization_id = '${org.organizationId}';`,
    );
    expect(count.trim()).toBe('0');
  });
});

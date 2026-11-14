import { idOf } from '@drefyn/tenancy';
import { describe, expect, it } from 'vitest';
import { AuthError, createSsoDomainRepository } from '../src/index.ts';
import { scriptedStore, type Statement } from './scripted-store.ts';
import { ADMIN, CONNECTION_A, ORG_A, ORG_B, accessFor } from './sso-domain-fakes.ts';

const DOMAIN_ID = '01890a5d-ac96-774b-bcce-b302099a8131';
const HASH = Buffer.alloc(32, 3);
const AT = new Date('2026-11-14T09:00:00.000Z');

const ROW = {
  id: DOMAIN_ID,
  connection_id: CONNECTION_A,
  domain: 'acme.test',
  txt_token_hash: HASH,
  verified_at: null,
  last_checked_at: null,
  failed_checks: 0,
  updated_at: AT,
};

const STORED = {
  id: DOMAIN_ID,
  connectionId: CONNECTION_A,
  domain: 'acme.test',
  tokenHash: HASH,
  verifiedAt: null,
  lastCheckedAt: null,
  failedChecks: 0,
  updatedAt: AT,
};

// Answers every statement with the rows given, and keeps what was sent.
function world(rows: readonly Record<string, unknown>[] = [ROW]) {
  let answer = rows;
  const scripted = scriptedStore(() => answer);
  const repository = createSsoDomainRepository({ store: scripted.store });
  return {
    scripted,
    repository,
    answer(next: readonly Record<string, unknown>[]) {
      answer = next;
    },
    last(): Statement {
      const statement = scripted.statements().at(-1);
      if (statement === undefined) throw new Error('nothing was sent');
      return statement;
    },
  };
}

describe('createSsoDomainRepository', () => {
  it('needs both pools or a store', () => {
    expect(() => createSsoDomainRepository({})).toThrow(AuthError);
    expect(() => createSsoDomainRepository({ db: {} as never })).toThrow(AuthError);
  });

  it('opens its transactions on the pools it is given', async () => {
    // Not pools from their constructors, so each transaction is refused before any I/O.
    const repository = createSsoDomainRepository({ db: {} as never, authDb: {} as never });
    await expect(repository.recentAuth(accessFor(ORG_A, ADMIN))).resolves.toMatchObject({
      ok: false,
    });
    await expect(repository.verifiedElsewhere(ORG_A, 'acme.test')).rejects.toThrow(
      /its own constructor/,
    );
    await expect(repository.inOrganization(ORG_A, ADMIN, () => Promise.resolve())).rejects.toThrow(
      /its own constructor/,
    );
    await expect(repository.inOrganization(ORG_A, null, () => Promise.resolve())).rejects.toThrow(
      /its own constructor/,
    );
  });

  it('runs organization work as the actor, and the recheck with none', async () => {
    const w = world();
    await w.repository.inOrganization(ORG_A, ADMIN, () => Promise.resolve());
    await w.repository.inOrganization(ORG_B, null, () => Promise.resolve());
    expect(w.scripted.events.filter((e) => e.kind === 'begin')).toEqual([
      { kind: 'begin', scope: 'organization', organizationId: ORG_A, actorUserId: ADMIN },
      { kind: 'begin', scope: 'organization', organizationId: ORG_B },
    ]);
  });

  it('reads the membership and plan of this organization', async () => {
    const w = world([{ role: 'admin', default_project_role: null, plan_tier: 'enterprise' }]);
    const [member, tier] = await w.repository.inOrganization(ORG_A, ADMIN, async (ops) => [
      await ops.member(ADMIN),
      await ops.planTier(),
    ]);
    expect(member).toEqual({ role: 'admin', defaultProjectRole: null });
    expect(tier).toBe('enterprise');
    const [memberSql, tierSql] = w.scripted.statements();
    expect(memberSql?.sql).toContain('from "memberships" where "user_id" = $1');
    expect(memberSql?.parameters).toEqual([ADMIN]);
    expect(tierSql?.sql).toContain('from "organizations" where "organization_id" = $1');
    expect(tierSql?.parameters).toEqual([ORG_A]);
    w.answer([]);
    const none = await w.repository.inOrganization(ORG_A, ADMIN, async (ops) => [
      await ops.member(ADMIN),
      await ops.planTier(),
      await ops.connectionExists(CONNECTION_A),
    ]);
    expect(none).toEqual([null, undefined, false]);
  });

  it('reads, locks and inserts domain rows', async () => {
    const w = world();
    const found = await w.repository.inOrganization(ORG_A, ADMIN, async (ops) => ({
      connection: await ops.connectionExists(CONNECTION_A),
      locked: await ops.lockDomainByName('acme.test'),
      byId: await ops.domainById(idOf('ssd', DOMAIN_ID)),
      inserted: await ops.insertDomain({
        connectionId: CONNECTION_A,
        domain: 'acme.test',
        tokenHash: HASH,
      }),
    }));
    expect(found).toEqual({ connection: true, locked: STORED, byId: STORED, inserted: STORED });
    const sent = w.scripted.statements().map((s) => s.sql);
    expect(sent[1]).toMatch(/where "domain" = \$1 for update$/);
    expect(sent[2]).toContain('where "id" = $1');
    expect(sent[3]).toMatch(/^insert into "sso_domains"/);
    expect(sent[3]).toContain('on conflict ("organization_id", "domain") do nothing');
    expect(w.last().parameters).toEqual([ORG_A, CONNECTION_A, 'acme.test', HASH]);
    w.answer([]);
    const missing = await w.repository.inOrganization(ORG_A, ADMIN, async (ops) => [
      await ops.lockDomainByName('acme.test'),
      await ops.insertDomain({ connectionId: CONNECTION_A, domain: 'acme.test', tokenHash: HASH }),
    ]);
    expect(missing).toEqual([null, null]);
  });

  it('reissues and verifies only against the token it read', async () => {
    const w = world();
    await w.repository.inOrganization(ORG_A, ADMIN, async (ops) => {
      await ops.reissueToken(DOMAIN_ID, CONNECTION_A, HASH);
      await ops.markVerified(DOMAIN_ID, HASH);
    });
    const [reissue, verify] = w.scripted.statements();
    expect(reissue?.sql).toMatch(
      /^update "sso_domains" set "connection_id" = \$1, "txt_token_hash" = \$2, "failed_checks" = \$3/,
    );
    expect(verify?.sql).toContain('"verified_at" = coalesce(verified_at, now())');
    expect(verify?.sql).toContain('where "id" = $2 and "txt_token_hash" = $3');
  });

  it('records a recheck only on the row as it was read, and only once a day', async () => {
    const w = world();
    await w.repository.inOrganization(ORG_A, null, async (ops) => {
      await ops.dueDomain('acme.test');
      await ops.recordFound(DOMAIN_ID, HASH, 1);
      await ops.recordMiss(DOMAIN_ID, HASH, 2, 3);
    });
    const [due, found, miss] = w.scripted.statements();
    for (const statement of [due, found, miss]) {
      expect(statement?.sql).toContain(
        "(last_checked_at is null or last_checked_at <= now() - interval '1 day')",
      );
      expect(statement?.sql).toContain('"verified_at" is not null');
    }
    expect(found?.sql).toContain('"failed_checks" = $');
    expect(miss?.sql).toContain('"failed_checks" = failed_checks + 1');
    expect(miss?.sql).toContain('case when failed_checks + 1 >= $1 then null else verified_at end');
    expect(miss?.parameters).toEqual([3, DOMAIN_ID, HASH, 2]);
  });

  it('lists the owners of this organization by address', async () => {
    const w = world([{ email: 'ada@acme.test' }, { email: 'grace@acme.test' }]);
    const owners = await w.repository.inOrganization(ORG_A, null, (ops) => ops.ownerAddresses());
    expect(owners).toEqual(['ada@acme.test', 'grace@acme.test']);
    expect(w.last().sql).toContain('"m"."role" = $1');
  });

  it('asks the sign in role whether another organization holds the domain verified', async () => {
    const w = world([{ organization_id: ORG_B }]);
    expect(await w.repository.verifiedElsewhere(ORG_A, 'acme.test')).toBe(true);
    expect(w.scripted.events[0]).toEqual({ kind: 'begin', scope: 'auth' });
    expect(w.last().sql).toContain('"organization_id" <> $2');
    expect(w.last().parameters).toEqual(['acme.test', ORG_A]);
    w.answer([]);
    expect(await w.repository.verifiedElsewhere(ORG_A, 'acme.test')).toBe(false);
  });

  it('pages through verified domains in key order', async () => {
    const w = world([{ organization_id: ORG_A, domain: 'acme.test' }]);
    expect(await w.repository.verifiedPage(null, 50)).toEqual([
      { organizationId: ORG_A, domain: 'acme.test' },
    ]);
    expect(w.last().sql).toMatch(/order by "organization_id", "domain" limit \$1$/);
    await w.repository.verifiedPage({ organizationId: ORG_A, domain: 'acme.test' }, 50);
    expect(w.last().sql).toContain('("organization_id", "domain") > ($1, $2)');
    expect(w.last().parameters).toEqual([ORG_A, 'acme.test', 50]);
  });

  it('checks a recent step up through the person transaction', async () => {
    const w = world([{ recent: true }]);
    expect(await w.repository.recentAuth(accessFor(ORG_A, ADMIN))).toEqual({
      ok: true,
      value: undefined,
    });
    expect(w.scripted.events[0]).toMatchObject({ kind: 'begin', scope: 'user', userId: ADMIN });
  });
});

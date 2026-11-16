import { DbError } from '@drefyn/db';
import { idOf } from '@drefyn/tenancy';
import { describe, expect, it } from 'vitest';
import { AuthError, createSsoDomains, type SsoDomainClaim } from '../src/index.ts';
import {
  ADMIN,
  ADMIN_B,
  CONNECTION_A,
  CONNECTION_A2,
  CONNECTION_B,
  MEMBER,
  ORG_A,
  ORG_B,
  accessFor,
  domainWorld,
  sha256Of,
  type DomainWorld,
} from './sso-domain-fakes.ts';

const admin = () => accessFor(ORG_A, ADMIN);
const adminB = () => accessFor(ORG_B, ADMIN_B, 'owner');

async function claimed(w: DomainWorld, domain = 'acme.test'): Promise<SsoDomainClaim> {
  const result = await w.domains.claimDomain(admin(), CONNECTION_A, domain);
  if (!result.ok) throw result.error;
  return result.value;
}

function codeOf(result: { ok: boolean; error?: unknown }): string | undefined {
  if (result.ok) return undefined;
  return result.error instanceof AuthError ? result.error.code : 'not an AuthError';
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

describe('claimDomain', () => {
  it('returns the TXT name and a 32 byte token, and stores only its hash', async () => {
    const w = domainWorld();
    const claim = await claimed(w);
    expect(claim.txtName).toBe('_drefyn-sso.acme.test');
    expect(claim.txtValue).toMatch(TOKEN);
    expect(Buffer.from(claim.txtValue ?? '', 'base64url')).toHaveLength(32);
    expect(claim.verified).toBe(false);
    const [row] = w.repo.rows;
    expect(w.repo.rows).toHaveLength(1);
    expect(row?.id).toBe(claim.domainId);
    expect(row?.domain).toBe('acme.test');
    expect(row?.organizationId).toBe(ORG_A);
    expect(row?.connectionId).toBe(CONNECTION_A);
    expect(row?.tokenHash.equals(sha256Of(claim.txtValue ?? ''))).toBe(true);
    expect(JSON.stringify(w.repo.rows)).not.toContain(claim.txtValue);
  });

  it('gives a new token for every claim, never one derived from the domain', async () => {
    const a = await claimed(domainWorld());
    const b = await claimed(domainWorld());
    expect(a.txtValue).not.toBe(b.txtValue);
  });

  it('returns the same row for a repeat claim, in any spelling, with a fresh token', async () => {
    const w = domainWorld();
    const first = await claimed(w);
    const again = await claimed(w, 'ACME.test.');
    expect(again.domainId).toBe(first.domainId);
    expect(w.repo.rows).toHaveLength(1);
    expect(again.txtValue).toMatch(TOKEN);
    expect(again.txtValue).not.toBe(first.txtValue);
    // Only the newest value can verify, since only its hash is kept.
    expect(w.repo.rows[0]?.tokenHash.equals(sha256Of(again.txtValue ?? ''))).toBe(true);
  });

  it('moves an unverified claim to the connection named in the repeat claim', async () => {
    const w = domainWorld();
    const first = await claimed(w);
    const again = await w.domains.claimDomain(admin(), CONNECTION_A2, 'acme.test');
    expect(again.ok && again.value.domainId).toBe(first.domainId);
    expect(w.repo.rows[0]?.connectionId).toBe(CONNECTION_A2);
  });

  it('leaves a verified claim and its token alone on a repeat claim', async () => {
    const w = domainWorld();
    const row = w.repo.seedVerified(ORG_A, CONNECTION_A, 'acme.test', 'published-token');
    const writes = w.repo.writes;
    const again = await w.domains.claimDomain(admin(), CONNECTION_A, 'acme.test');
    expect(again).toEqual({
      ok: true,
      value: { domainId: row.id, txtName: '_drefyn-sso.acme.test', txtValue: null, verified: true },
    });
    expect(w.repo.writes).toBe(writes);
    expect(w.repo.rows[0]?.tokenHash.equals(sha256Of('published-token'))).toBe(true);
  });

  it('refuses to move a verified claim to another connection', async () => {
    const w = domainWorld();
    w.repo.seedVerified(ORG_A, CONNECTION_A, 'acme.test', 'published-token');
    const writes = w.repo.writes;
    const moved = await w.domains.claimDomain(admin(), CONNECTION_A2, 'acme.test');
    expect(codeOf(moved)).toBe('AUTH_INPUT_INVALID');
    expect(w.repo.writes).toBe(writes);
  });

  it('treats a subdomain as its own claim', async () => {
    const w = domainWorld();
    const parent = await claimed(w, 'acme.test');
    const child = await claimed(w, 'eu.acme.test');
    expect(child.domainId).not.toBe(parent.domainId);
    expect(child.txtName).toBe('_drefyn-sso.eu.acme.test');
    expect(w.repo.rows.map((r) => r.domain).sort()).toEqual(['acme.test', 'eu.acme.test']);
  });

  it('stores an IDN domain in its ASCII form', async () => {
    const w = domainWorld();
    const claim = await claimed(w, 'Bücher.test');
    expect(claim.txtName).toBe('_drefyn-sso.xn--bcher-kva.test');
    expect(w.repo.rows[0]?.domain).toBe('xn--bcher-kva.test');
  });

  it.each([
    ['no dot', 'localhost'],
    ['an IP address', '192.168.0.1'],
    ['an address', 'ada@acme.test'],
    ['an underscore label', '_dmarc.acme.test'],
    ['a wildcard', '*.acme.test'],
    ['a port', 'acme.test:443'],
    ['a path', 'acme.test/x'],
    ['an empty string', ''],
    ['a leading dot', '.acme.test'],
    ['two trailing dots', 'acme.test..'],
    [
      'a name too long for its TXT name',
      `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(57)}.test`,
    ],
  ])('refuses %s with AUTH_INPUT_INVALID and writes nothing', async (_name, domain) => {
    const w = domainWorld();
    const result = await w.domains.claimDomain(admin(), CONNECTION_A, domain);
    expect(codeOf(result)).toBe('AUTH_INPUT_INVALID');
    expect(w.repo.writes).toBe(0);
  });

  it('refuses a value that is not a string or a connection id that is not one', async () => {
    const w = domainWorld();
    const notString = await w.domains.claimDomain(admin(), CONNECTION_A, 42 as unknown as string);
    expect(codeOf(notString)).toBe('AUTH_INPUT_INVALID');
    const badId = await w.domains.claimDomain(admin(), 'ssc_nope' as never, 'acme.test');
    expect(codeOf(badId)).toBe('AUTH_INPUT_INVALID');
    expect(w.repo.writes).toBe(0);
  });

  it('refuses a connection the organization does not have', async () => {
    const w = domainWorld();
    const result = await w.domains.claimDomain(admin(), CONNECTION_B, 'acme.test');
    expect(codeOf(result)).toBe('AUTH_NOT_FOUND');
    expect(w.repo.writes).toBe(0);
  });

  it('refuses a domain another organization holds verified', async () => {
    const w = domainWorld();
    w.repo.seedVerified(ORG_B, CONNECTION_B, 'acme.test', 'theirs');
    const result = await w.domains.claimDomain(admin(), CONNECTION_A, 'acme.test');
    expect(codeOf(result)).toBe('AUTH_SSO_DOMAIN_TAKEN');
    expect(w.repo.rows).toHaveLength(1);
  });
});

describe('refused domains', () => {
  it.each([
    ['a top level domain', 'com'],
    ['a two label public suffix', 'co.uk'],
    ['a private public suffix', 'github.io'],
    ['a name under a wildcard rule', 'anything.ck'],
    ['an IDN public suffix', '公司.cn'],
    ['an IDN public suffix in ASCII', 'xn--55qx5d.cn'],
    ['a free mail domain', 'gmail.com'],
    ['a free mail domain in capitals', 'Outlook.COM'],
    ['a subdomain of a free mail domain', 'eu.mail.yahoo.com'],
    ['a domain from the extra file', 'mail.corp.test'],
    ['a subdomain of a domain from the extra file', 'x.mail.corp.test'],
  ])('refuses %s with AUTH_SSO_DOMAIN_REFUSED', async (_name, domain) => {
    const w = domainWorld({ extraFreeMail: ['Mail.Corp.Test'] });
    const result = await w.domains.claimDomain(admin(), CONNECTION_A, domain);
    expect(codeOf(result)).toBe('AUTH_SSO_DOMAIN_REFUSED');
    expect(w.repo.writes).toBe(0);
    expect(w.events.events).toEqual([]);
  });

  it.each([
    ['a registrable name under a public suffix', 'acme.co.uk'],
    ['an exception to a wildcard rule', 'www.ck'],
    ['a project on a private suffix', 'acme.github.io'],
    ['a name that only ends like a free mail domain', 'notgmail.com'],
  ])('allows %s', async (_name, domain) => {
    const w = domainWorld({ extraFreeMail: ['mail.corp.test'] });
    const result = await w.domains.claimDomain(admin(), CONNECTION_A, domain);
    expect(result.ok).toBe(true);
  });
});

describe('verifyDomain', () => {
  it('verifies when a TXT answer holds the token', async () => {
    const w = domainWorld();
    const claim = await claimed(w);
    w.dns.answer(claim.txtName, ['v=spf1 -all', claim.txtValue ?? '']);
    const result = await w.domains.verifyDomain(admin(), claim.domainId);
    expect(result).toEqual({
      ok: true,
      value: {
        domainId: claim.domainId,
        connectionId: CONNECTION_A,
        domain: 'acme.test',
        verifiedAt: w.repo.now,
        lastCheckedAt: w.repo.now,
        failedChecks: 0,
      },
    });
    expect(w.dns.calls).toEqual(['_drefyn-sso.acme.test']);
    expect(w.repo.rows[0]?.verifiedAt).toEqual(w.repo.now);
  });

  it('accepts the token with spaces around it, as some DNS panels add them', async () => {
    const w = domainWorld();
    const claim = await claimed(w);
    w.dns.answer(claim.txtName, [`  ${claim.txtValue ?? ''} `]);
    expect((await w.domains.verifyDomain(admin(), claim.domainId)).ok).toBe(true);
  });

  it.each<[string, (token: string) => readonly string[]]>([
    ['no record', () => []],
    ['a wrong token', () => ['A'.repeat(43)]],
    ['a partial token', (t) => [t.slice(0, 42)]],
    ['the token inside a longer value', (t) => [`drefyn=${t}`]],
    [
      'the token in another case',
      (t) => [t.toUpperCase() === t ? t.toLowerCase() : t.toUpperCase()],
    ],
    ['the token split over two records', (t) => [t.slice(0, 20), t.slice(20)]],
  ])('refuses %s with AUTH_SSO_DOMAIN_UNVERIFIED and keeps it unverified', async (_n, records) => {
    const w = domainWorld();
    const claim = await claimed(w);
    w.dns.answer(claim.txtName, records(claim.txtValue ?? ''));
    const result = await w.domains.verifyDomain(admin(), claim.domainId);
    expect(codeOf(result)).toBe('AUTH_SSO_DOMAIN_UNVERIFIED');
    expect(w.repo.rows[0]?.verifiedAt).toBeNull();
  });

  it('refuses the token of an earlier claim once a repeat claim replaced it', async () => {
    const w = domainWorld();
    const first = await claimed(w);
    await claimed(w);
    w.dns.answer(first.txtName, [first.txtValue ?? '']);
    const result = await w.domains.verifyDomain(admin(), first.domainId);
    expect(codeOf(result)).toBe('AUTH_SSO_DOMAIN_UNVERIFIED');
  });

  it('answers AUTH_UNAVAILABLE when the lookup cannot say, and writes nothing', async () => {
    const w = domainWorld();
    const claim = await claimed(w);
    w.dns.unknown(claim.txtName);
    const writes = w.repo.writes;
    const result = await w.domains.verifyDomain(admin(), claim.domainId);
    expect(codeOf(result)).toBe('AUTH_UNAVAILABLE');
    expect(w.repo.writes).toBe(writes);
  });

  it('answers AUTH_UNAVAILABLE when the resolver throws', async () => {
    const w = domainWorld();
    const claim = await claimed(w);
    w.dns.script(claim.txtName, () => Promise.reject(new Error('socket closed')));
    expect(codeOf(await w.domains.verifyDomain(admin(), claim.domainId))).toBe('AUTH_UNAVAILABLE');
  });

  it('answers AUTH_SSO_DOMAIN_TAKEN when another organization verified it first', async () => {
    const w = domainWorld();
    const claim = await claimed(w);
    w.repo.seedVerified(ORG_B, CONNECTION_B, 'acme.test', 'theirs');
    w.dns.answer(claim.txtName, [claim.txtValue ?? '']);
    const result = await w.domains.verifyDomain(admin(), claim.domainId);
    expect(codeOf(result)).toBe('AUTH_SSO_DOMAIN_TAKEN');
    expect(w.repo.rows.find((r) => r.organizationId === ORG_A)?.verifiedAt).toBeNull();
  });

  it('answers AUTH_SSO_DOMAIN_UNVERIFIED when the token changed during the lookup', async () => {
    const w = domainWorld();
    const claim = await claimed(w);
    w.dns.script(claim.txtName, async () => {
      await w.domains.claimDomain(admin(), CONNECTION_A, 'acme.test');
      return { kind: 'answer', records: [claim.txtValue ?? ''] };
    });
    const result = await w.domains.verifyDomain(admin(), claim.domainId);
    expect(codeOf(result)).toBe('AUTH_SSO_DOMAIN_UNVERIFIED');
  });

  it('refuses an unknown or malformed domain id', async () => {
    const w = domainWorld();
    const unknown = idOf('ssd', '01890a5d-ac96-774b-bcce-b302099a8199');
    expect(codeOf(await w.domains.verifyDomain(admin(), unknown))).toBe('AUTH_NOT_FOUND');
    expect(codeOf(await w.domains.verifyDomain(admin(), 'nope' as never))).toBe(
      'AUTH_INPUT_INVALID',
    );
    expect(w.dns.calls).toEqual([]);
  });

  it("cannot verify another organization's claim by its id", async () => {
    const w = domainWorld();
    const claim = await claimed(w);
    w.dns.answer(claim.txtName, [claim.txtValue ?? '']);
    const result = await w.domains.verifyDomain(adminB(), claim.domainId);
    expect(codeOf(result)).toBe('AUTH_NOT_FOUND');
  });

  it('keeps the first verified time when a verified domain is checked again', async () => {
    const w = domainWorld();
    const claim = await claimed(w);
    w.dns.answer(claim.txtName, [claim.txtValue ?? '']);
    await w.domains.verifyDomain(admin(), claim.domainId);
    const first = w.repo.now;
    w.repo.advance(60_000);
    const again = await w.domains.verifyDomain(admin(), claim.domainId);
    expect(again.ok && again.value.verifiedAt).toEqual(first);
    expect(again.ok && again.value.lastCheckedAt).toEqual(w.repo.now);
    // Only the first verification is news to the owners.
    expect(w.mailer.sent.filter((m) => m.notice.kind === 'sso_domain_verified')).toHaveLength(2);
    expect(w.events.events.filter((e) => e.type === 'sso.domain_verified')).toHaveLength(1);
  });
});

describe('the sso_domain_verify limit', () => {
  it('refuses the 21st verify in an hour for one organization, before any lookup', async () => {
    const w = domainWorld();
    const claim = await claimed(w);
    for (let i = 0; i < 20; i += 1) {
      const result = await w.domains.verifyDomain(admin(), claim.domainId);
      expect(codeOf(result)).toBe('AUTH_SSO_DOMAIN_UNVERIFIED');
    }
    const lookups = w.dns.calls.length;
    const refused = await w.domains.verifyDomain(admin(), claim.domainId);
    expect(codeOf(refused)).toBe('AUTH_RATE_LIMITED');
    expect(refused.ok ? null : refused.error.retryAfterSeconds).toBe(3600);
    expect(w.dns.calls).toHaveLength(lookups);
  });

  it('counts each organization on its own', async () => {
    const w = domainWorld();
    const claim = await claimed(w);
    for (let i = 0; i < 20; i += 1) await w.domains.verifyDomain(admin(), claim.domainId);
    const other = await w.domains.claimDomain(adminB(), CONNECTION_B, 'other.test');
    if (!other.ok) throw other.error;
    const result = await w.domains.verifyDomain(adminB(), other.value.domainId);
    expect(codeOf(result)).toBe('AUTH_SSO_DOMAIN_UNVERIFIED');
  });
});

describe('every call is refused, and writes nothing, without', () => {
  type Call = (w: DomainWorld, a: ReturnType<typeof admin>) => Promise<{ ok: boolean }>;
  const calls: readonly [string, Call][] = [
    ['claimDomain', (w, a) => w.domains.claimDomain(a, CONNECTION_A, 'acme.test')],
    [
      'verifyDomain',
      async (w, a) => {
        const row = w.repo.rows[0];
        if (row === undefined) throw new Error('no claim');
        return w.domains.verifyDomain(a, idOf('ssd', row.id));
      },
    ],
  ];

  async function prepared() {
    const w = domainWorld();
    const claim = await claimed(w);
    w.dns.answer(claim.txtName, [claim.txtValue ?? '']);
    w.mailer.sent.length = 0;
    w.events.events.length = 0;
    w.dns.calls.length = 0;
    w.lines.length = 0;
    return { w, writes: w.repo.writes, rateRows: w.memory.counts.size };
  }

  function nothingHappened(w: DomainWorld, before: { writes: number; rateRows: number }): void {
    expect(w.repo.writes).toBe(before.writes);
    expect(w.memory.counts.size).toBe(before.rateRows);
    expect(w.dns.calls).toEqual([]);
    expect(w.mailer.sent).toEqual([]);
    expect(w.events.events).toEqual([]);
  }

  it.each(calls)('org.manage_settings (%s)', async (_name, call) => {
    const { w, ...before } = await prepared();
    const result = await call(w, accessFor(ORG_A, MEMBER, 'member'));
    expect(codeOf(result)).toBe('AUTH_FORBIDDEN');
    nothingHappened(w, before);
  });

  it.each(calls)('a membership at all (%s)', async (_name, call) => {
    const { w, ...before } = await prepared();
    const stranger = idOf('usr', '01890a5d-ac96-774b-bcce-b302099a8177');
    const result = await call(w, accessFor(ORG_A, stranger, 'owner'));
    expect(codeOf(result)).toBe('AUTH_FORBIDDEN');
    nothingHappened(w, before);
  });

  it.each(calls)('the stored role, whatever the context says (%s)', async (_name, call) => {
    const { w, ...before } = await prepared();
    // The guard saw an owner; the membership has since been lowered to member.
    const result = await call(w, accessFor(ORG_A, MEMBER, 'owner'));
    expect(codeOf(result)).toBe('AUTH_FORBIDDEN');
    nothingHappened(w, before);
  });

  it.each(calls)('a recent step up (%s)', async (_name, call) => {
    const { w, ...before } = await prepared();
    w.repo.setRecent(false);
    const result = await call(w, admin());
    expect(codeOf(result)).toBe('AUTH_RECENT_AUTH_REQUIRED');
    nothingHappened(w, before);
  });

  it.each(calls)('the org.sso_saml entitlement (%s)', async (_name, call) => {
    const { w, ...before } = await prepared();
    w.repo.setTier(ORG_A, 'scale');
    const result = await call(w, admin());
    expect(codeOf(result)).toBe('AUTH_SSO_DISABLED');
    nothingHappened(w, before);
  });

  it.each(calls)('the auth.team_sso flag (%s)', async (_name, call) => {
    const { w, ...before } = await prepared();
    w.flags.set(false);
    const result = await call(w, admin());
    expect(codeOf(result)).toBe('AUTH_SSO_DISABLED');
    nothingHappened(w, before);
    expect(w.flags.calls.at(-1)).toEqual({
      name: 'auth.team_sso',
      organizationId: ORG_A,
      userId: ADMIN,
    });
  });

  it.each(calls)('a flag answer, taking a failed evaluation as off (%s)', async (_n, call) => {
    const { w, ...before } = await prepared();
    w.flags.throwing();
    const result = await call(w, admin());
    expect(codeOf(result)).toBe('AUTH_SSO_DISABLED');
    nothingHappened(w, before);
  });

  it.each(calls)('works with the flag on, on self hosted too (%s)', async (_name, call) => {
    const { w } = await prepared();
    w.repo.setTier(ORG_A, 'self_hosted');
    w.flags.set(true);
    expect((await call(w, admin())).ok).toBe(true);
  });

  it.each(calls)('a working database answers AUTH_UNAVAILABLE (%s)', async (_name, call) => {
    const { w, ...before } = await prepared();
    w.repo.failNextTransaction(new Error('connection reset'));
    const result = await call(w, admin());
    expect(codeOf(result)).toBe('AUTH_UNAVAILABLE');
    expect(w.repo.writes).toBe(before.writes);
  });
});

describe('events and notices', () => {
  it('records an event and tells every owner on claim and on verify', async () => {
    const w = domainWorld();
    const claim = await claimed(w);
    w.dns.answer(claim.txtName, [claim.txtValue ?? '']);
    await w.domains.verifyDomain(admin(), claim.domainId);
    expect(w.events.events.map((e) => e.type)).toEqual([
      'sso.domain_claimed',
      'sso.domain_verified',
    ]);
    for (const event of w.events.events) {
      expect(event).toMatchObject({
        organizationId: ORG_A,
        connectionId: CONNECTION_A,
        domainId: claim.domainId,
        actorUserId: ADMIN,
      });
      expect(event.domainKey).toMatch(/^[0-9a-f]{16}$/);
      expect(event.at).toBeInstanceOf(Date);
    }
    expect(w.mailer.sent.map((m) => [m.to, m.notice.kind])).toEqual([
      ['ada@acme.test', 'sso_domain_claimed'],
      ['grace@acme.test', 'sso_domain_claimed'],
      ['ada@acme.test', 'sso_domain_verified'],
      ['grace@acme.test', 'sso_domain_verified'],
    ]);
    // The owners need to know which domain; the mail is the one place it appears.
    expect(w.mailer.sent[0]?.notice).toMatchObject({
      organizationId: ORG_A,
      domainId: claim.domainId,
      domain: 'acme.test',
    });
  });

  it('keeps the same domain key for the same domain, and a different one for another', async () => {
    const w = domainWorld();
    await claimed(w, 'acme.test');
    await claimed(w, 'acme.test');
    await claimed(w, 'eu.acme.test');
    const [a, b, c] = w.events.events.map((e) => e.domainKey);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it('finishes the call when the mailer and the event sink fail, and says so in the log', async () => {
    const w = domainWorld();
    w.mailer.failing = true;
    w.events.failing = true;
    const result = await w.domains.claimDomain(admin(), CONNECTION_A, 'acme.test');
    expect(result.ok).toBe(true);
    expect(w.lines.map((l) => l.event)).toEqual(
      expect.arrayContaining(['auth.sso_domain_notice_failed', 'auth.sso_domain_event_failed']),
    );
  });

  it('survives a logger that throws', async () => {
    const w = domainWorld({
      deps: {
        logger: {
          warn() {
            throw new Error('log sink down');
          },
          info() {
            throw new Error('log sink down');
          },
        },
      },
    });
    w.mailer.failing = true;
    expect((await w.domains.claimDomain(admin(), CONNECTION_A, 'acme.test')).ok).toBe(true);
    expect(codeOf(await w.domains.claimDomain(admin(), CONNECTION_A, 'gmail.com'))).toBe(
      'AUTH_SSO_DOMAIN_REFUSED',
    );
  });
});

describe('redaction', () => {
  it('never puts the domain in clear or the token in a log line or event', async () => {
    const w = domainWorld({ extraFreeMail: ['mail.corp.test'] });
    const claim = await claimed(w, 'Secret-Project.test');
    const token = claim.txtValue ?? '';
    w.dns.answer(claim.txtName, ['wrong']);
    await w.domains.verifyDomain(admin(), claim.domainId);
    w.dns.unknown(claim.txtName);
    await w.domains.verifyDomain(admin(), claim.domainId);
    w.dns.answer(claim.txtName, [token]);
    await w.domains.verifyDomain(admin(), claim.domainId);
    await w.domains.claimDomain(admin(), CONNECTION_A, 'mail.corp.test');
    await w.domains.claimDomain(admin(), CONNECTION_A, 'not a domain');
    w.repo.seedVerified(ORG_B, CONNECTION_B, 'taken-elsewhere.test', 'x');
    await w.domains.claimDomain(admin(), CONNECTION_A, 'taken-elsewhere.test');
    w.flags.set(false);
    await w.domains.claimDomain(admin(), CONNECTION_A, 'flag-off.test');

    expect(w.lines.length).toBeGreaterThan(5);
    const written = JSON.stringify([w.lines, w.events.events]).toLowerCase();
    for (const secret of [
      'secret-project',
      'mail.corp',
      'corp.test',
      'taken-elsewhere',
      'flag-off',
      'not a domain',
      token.toLowerCase(),
      '_drefyn-sso',
    ]) {
      expect(written).not.toContain(secret);
    }
    const withOrg = w.lines.filter((l) => l.event.startsWith('auth.sso_domain'));
    expect(withOrg.length).toBe(w.lines.length);
    expect(withOrg.every((l) => String(l.fields['organizationId']).startsWith('org_'))).toBe(true);
  });
});

describe('an unexpected database error', () => {
  it('reads a raw 23505 from inside the work as AUTH_SSO_DOMAIN_TAKEN', async () => {
    const w = domainWorld();
    const claim = await claimed(w);
    w.dns.answer(claim.txtName, [claim.txtValue ?? '']);
    const raw = Object.assign(new Error('duplicate key'), { code: '23505' });
    const racing = createSsoDomains({
      ...w.deps,
      repository: {
        ...w.repo.repository,
        inOrganization: (organizationId, actor, work) =>
          w.repo.repository.inOrganization(organizationId, actor, (ops) =>
            work({ ...ops, markVerified: () => Promise.reject(raw) }),
          ),
      },
    });
    expect(codeOf(await racing.verifyDomain(admin(), claim.domainId))).toBe(
      'AUTH_SSO_DOMAIN_TAKEN',
    );
  });

  it('answers AUTH_UNAVAILABLE when marking verified fails for another reason', async () => {
    const w = domainWorld();
    const claim = await claimed(w);
    w.dns.answer(claim.txtName, [claim.txtValue ?? '']);
    const broken = createSsoDomains({
      ...w.deps,
      repository: {
        ...w.repo.repository,
        inOrganization: (organizationId, actor, work) =>
          w.repo.repository.inOrganization(organizationId, actor, (ops) =>
            work({ ...ops, markVerified: () => Promise.reject(new Error('disk full')) }),
          ),
      },
    });
    const result = await broken.verifyDomain(admin(), claim.domainId);
    expect(codeOf(result)).toBe('AUTH_UNAVAILABLE');
    expect(w.repo.rows[0]?.verifiedAt).toBeNull();
  });

  it('maps a unique violation outside verification to AUTH_UNAVAILABLE', async () => {
    const w = domainWorld();
    w.repo.failNextTransaction(new DbError('DB_UNIQUE_VIOLATION', 'unique constraint refused'));
    const result = await w.domains.claimDomain(admin(), CONNECTION_A, 'acme.test');
    expect(codeOf(result)).toBe('AUTH_UNAVAILABLE');
  });
});

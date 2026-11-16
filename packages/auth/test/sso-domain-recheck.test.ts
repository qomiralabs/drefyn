import { describe, expect, it } from 'vitest';
import { createSsoDomainRecheck } from '../src/index.ts';
import {
  ADMIN,
  CONNECTION_A,
  CONNECTION_B,
  ORG_A,
  ORG_B,
  accessFor,
  domainWorld,
  type DomainWorld,
} from './sso-domain-fakes.ts';

const DAY = 86_400_000;
const NAME = '_drefyn-sso.acme.test';
const TOKEN = 'published-token-value';

function verifiedWorld() {
  const w = domainWorld();
  const row = w.repo.seedVerified(ORG_A, CONNECTION_A, 'acme.test', TOKEN);
  return { w, row };
}

// One daily run: the clock moves a day, then the job runs.
async function nextDay(w: DomainWorld, answer: 'found' | 'missed' | 'unknown' | 'nxdomain') {
  w.repo.advance(DAY);
  if (answer === 'found') w.dns.answer(NAME, ['other', TOKEN]);
  if (answer === 'missed') w.dns.answer(NAME, ['other']);
  if (answer === 'nxdomain') w.dns.answer(NAME, []);
  if (answer === 'unknown') w.dns.unknown(NAME);
  return w.recheck.runOnce();
}

const state = (w: DomainWorld) => {
  const row = w.repo.rows.find((r) => r.domain === 'acme.test' && r.organizationId === ORG_A);
  return { verified: row?.verifiedAt !== null, failedChecks: row?.failedChecks };
};

describe('the daily recheck', () => {
  it('unverifies after three answered misses in a row and mails every owner', async () => {
    const { w, row } = verifiedWorld();
    await nextDay(w, 'missed');
    await nextDay(w, 'nxdomain');
    expect(state(w)).toEqual({ verified: true, failedChecks: 2 });
    expect(w.mailer.sent).toEqual([]);
    const third = await nextDay(w, 'missed');
    expect(third).toMatchObject({ checked: 1, missed: 1, unverified: 1 });
    expect(state(w)).toEqual({ verified: false, failedChecks: 3 });
    expect(w.mailer.sent.map((m) => [m.to, m.notice.kind])).toEqual([
      ['ada@acme.test', 'sso_domain_unverified'],
      ['grace@acme.test', 'sso_domain_unverified'],
    ]);
    expect(w.mailer.sent[0]?.notice).toMatchObject({
      organizationId: ORG_A,
      domainId: row.id,
      domain: 'acme.test',
    });
    expect(w.events.events).toHaveLength(1);
    expect(w.events.events[0]).toMatchObject({
      type: 'sso.domain_unverified',
      organizationId: ORG_A,
      connectionId: CONNECTION_A,
      domainId: row.id,
      actorUserId: null,
    });
    expect(w.events.events[0]?.domainKey).toMatch(/^[0-9a-f]{16}$/);
  });

  it('never counts a timeout, before, between or after misses', async () => {
    const { w } = verifiedWorld();
    await nextDay(w, 'unknown');
    await nextDay(w, 'missed');
    await nextDay(w, 'unknown');
    await nextDay(w, 'unknown');
    await nextDay(w, 'missed');
    const run = await nextDay(w, 'unknown');
    expect(run).toMatchObject({ checked: 1, unknown: 1, missed: 0 });
    expect(state(w)).toEqual({ verified: true, failedChecks: 2 });
    await nextDay(w, 'missed');
    expect(state(w)).toEqual({ verified: false, failedChecks: 3 });
  });

  it('checks again on the next run after a timeout, not a day later', async () => {
    const { w } = verifiedWorld();
    await nextDay(w, 'unknown');
    w.repo.advance(60 * 60 * 1000);
    w.dns.answer(NAME, ['other']);
    const run = await w.recheck.runOnce();
    expect(run).toMatchObject({ checked: 1, missed: 1 });
  });

  it('counts a resolver that throws as unknown', async () => {
    const { w } = verifiedWorld();
    w.repo.advance(DAY);
    w.dns.script(NAME, () => Promise.reject(new Error('socket closed')));
    expect(await w.recheck.runOnce()).toMatchObject({ unknown: 1 });
    expect(state(w)).toEqual({ verified: true, failedChecks: 0 });
  });

  it('resets the count on a success', async () => {
    const { w } = verifiedWorld();
    await nextDay(w, 'missed');
    await nextDay(w, 'missed');
    const found = await nextDay(w, 'found');
    expect(found).toMatchObject({ checked: 1, confirmed: 1 });
    expect(state(w)).toEqual({ verified: true, failedChecks: 0 });
    await nextDay(w, 'missed');
    await nextDay(w, 'missed');
    expect(state(w)).toEqual({ verified: true, failedChecks: 2 });
    expect(w.mailer.sent).toEqual([]);
    expect(w.events.events).toEqual([]);
  });

  it('looks a domain up at most once a day', async () => {
    const { w } = verifiedWorld();
    await nextDay(w, 'missed');
    w.repo.advance(DAY - 60_000);
    const early = await w.recheck.runOnce();
    expect(early).toMatchObject({ checked: 0, skipped: 1 });
    expect(w.dns.calls).toHaveLength(1);
  });

  it('leaves unverified claims alone', async () => {
    const w = domainWorld();
    const { ok } = await w.domains.claimDomain(accessFor(ORG_A, ADMIN), CONNECTION_A, 'acme.test');
    expect(ok).toBe(true);
    w.repo.advance(DAY);
    expect(await w.recheck.runOnce()).toMatchObject({ checked: 0 });
    expect(w.dns.calls).toEqual([]);
  });

  it('skips an organization with the flag off, and keeps its rows as they are', async () => {
    const { w } = verifiedWorld();
    w.flags.offFor(ORG_A);
    w.repo.advance(DAY);
    w.dns.answer(NAME, []);
    const run = await w.recheck.runOnce();
    expect(run).toMatchObject({ checked: 0, skipped: 1 });
    expect(w.dns.calls).toEqual([]);
    expect(state(w)).toEqual({ verified: true, failedChecks: 0 });
    expect(w.flags.calls.at(-1)).toEqual({ name: 'auth.team_sso', organizationId: ORG_A });
  });

  it('skips an organization whose flag evaluation fails', async () => {
    const { w } = verifiedWorld();
    w.flags.throwing();
    w.repo.advance(DAY);
    expect(await w.recheck.runOnce()).toMatchObject({ checked: 0, skipped: 1 });
  });

  it('skips an organization that lost the entitlement, without unverifying', async () => {
    const { w } = verifiedWorld();
    w.repo.setTier(ORG_A, 'growth');
    for (let day = 0; day < 4; day += 1) await nextDay(w, 'missed');
    expect(w.dns.calls).toEqual([]);
    expect(state(w)).toEqual({ verified: true, failedChecks: 0 });
  });

  it('counts a row another server checked first as skipped, not a second strike', async () => {
    const { w } = verifiedWorld();
    w.repo.advance(DAY);
    w.dns.script(NAME, async () => {
      // Another server finishes the same check while this one waits on DNS.
      w.dns.answer(NAME, ['other']);
      await w.recheck.runOnce();
      return { kind: 'answer', records: ['other'] };
    });
    const run = await w.recheck.runOnce();
    expect(run).toMatchObject({ checked: 1, skipped: 1, missed: 0 });
    expect(state(w)).toEqual({ verified: true, failedChecks: 1 });
  });

  it('counts a success another server recorded first as skipped', async () => {
    const { w } = verifiedWorld();
    await nextDay(w, 'missed');
    w.repo.advance(DAY);
    w.dns.script(NAME, async () => {
      w.dns.answer(NAME, [TOKEN]);
      await w.recheck.runOnce();
      return { kind: 'answer', records: [TOKEN] };
    });
    expect(await w.recheck.runOnce()).toMatchObject({ checked: 1, skipped: 1, confirmed: 0 });
    expect(state(w)).toEqual({ verified: true, failedChecks: 0 });
  });

  it('checks every organization, page by page, and stops at the run limit', async () => {
    const w = domainWorld();
    for (let i = 0; i < 5; i += 1) {
      w.repo.seedVerified(ORG_A, CONNECTION_A, `d${String(i)}.acme.test`, TOKEN);
      w.repo.seedVerified(ORG_B, CONNECTION_B, `d${String(i)}.other.test`, TOKEN);
    }
    w.repo.advance(DAY);
    const small = createSsoDomainRecheck({
      repository: w.repo.repository,
      keys: w.keys,
      resolver: w.dns.resolver,
      flag: w.flags.flag,
      logger: { warn: () => undefined },
      mailer: w.mailer,
      events: w.events,
      pageSize: 3,
      maxPerRun: 7,
    });
    const first = await small.runOnce();
    expect(first).toMatchObject({ checked: 7, missed: 7, more: true });
    const second = await small.runOnce();
    // The seven checked today are not due, so the run reaches the other three.
    expect(second).toMatchObject({ checked: 3, more: false });
    expect(new Set(w.dns.calls).size).toBe(10);
  });

  it('keeps going past an organization whose transaction fails', async () => {
    const w = domainWorld();
    w.repo.seedVerified(ORG_A, CONNECTION_A, 'acme.test', TOKEN);
    w.repo.seedVerified(ORG_B, CONNECTION_B, 'other.test', TOKEN);
    w.repo.advance(DAY);
    w.repo.failNextTransaction(new Error('connection reset'));
    const run = await w.recheck.runOnce();
    expect(run).toMatchObject({ failed: 1, checked: 1 });
    expect(w.lines.map((l) => l.event)).toContain('auth.sso_domain_recheck_failed');
  });

  it('reports a failed listing as a failed run rather than throwing', async () => {
    const w = domainWorld();
    const broken = createSsoDomainRecheck({
      repository: {
        ...w.repo.repository,
        verifiedPage: () => Promise.reject(new Error('auth pool down')),
      },
      keys: w.keys,
      resolver: w.dns.resolver,
      flag: w.flags.flag,
      logger: { warn: () => undefined },
      mailer: w.mailer,
      events: w.events,
    });
    expect(await broken.runOnce()).toMatchObject({ checked: 0, failed: 1 });
  });

  it('finishes an unverify when mail and events fail', async () => {
    const { w } = verifiedWorld();
    w.mailer.failing = true;
    w.events.failing = true;
    await nextDay(w, 'missed');
    await nextDay(w, 'missed');
    await nextDay(w, 'missed');
    expect(state(w)).toEqual({ verified: false, failedChecks: 3 });
    expect(w.lines.map((l) => l.event)).toEqual(
      expect.arrayContaining(['auth.sso_domain_notice_failed', 'auth.sso_domain_event_failed']),
    );
  });

  it('logs no domain in clear and no token', async () => {
    const { w } = verifiedWorld();
    await nextDay(w, 'missed');
    await nextDay(w, 'unknown');
    await nextDay(w, 'found');
    await nextDay(w, 'missed');
    await nextDay(w, 'missed');
    await nextDay(w, 'missed');
    expect(w.lines.length).toBeGreaterThan(0);
    const written = JSON.stringify([w.lines, w.events.events]);
    expect(written).not.toContain('acme');
    expect(written).not.toContain(TOKEN);
  });
});

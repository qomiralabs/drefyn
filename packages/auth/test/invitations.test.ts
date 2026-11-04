import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuthDatabase, Database } from '@drefyn/db';
import { limitFor } from '@drefyn/entitlements';
import { idOf, type OrganizationId } from '@drefyn/tenancy';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { grantAccess, type AccessContext } from '../src/access.ts';
import {
  AuthError,
  ORG_ROLES,
  canAssign,
  createInvitations,
  formatInvitationToken,
  parseAuthConfig,
  parseInvitationToken,
  type AuthConfig,
  type InvitationSend,
  type InvitationsDeps,
  type OrgRole,
  type RateLimiter,
  type AuthSecurityNotice,
} from '../src/index.ts';
import { formatBlockToken, parseBlockToken } from '../src/invitation-links.ts';
import {
  scriptedStore,
  type Responder,
  type ScriptedStore,
  type Statement,
} from './scripted-store.ts';
import {
  AUTHENTICATED_AT,
  SESSION,
  USER,
  capturingLogger,
  config,
  noopLimiter,
  sessionInfo,
  sha,
} from './session-fixtures.ts';
import { base64url, runs, validEnv } from './support.ts';

const ORG: OrganizationId = idOf('org', '01890a5d-ac96-774b-bcce-b302099a8070');
const INV = idOf('inv', '01890a5d-ac96-774b-bcce-b302099a8072');
const ACTOR_MEMBERSHIP = '01890a5d-ac96-774b-bcce-b302099a8071';
const INVITER_MEMBERSHIP = '01890a5d-ac96-774b-bcce-b302099a8073';
const NEW_MEMBERSHIP = '01890a5d-ac96-774b-bcce-b302099a8074';
const ADDRESS = 'newcomer@example.com';
const SECRET = Buffer.alloc(32, 5);
const EXPIRES = new Date('2026-11-10T10:00:00.000Z');
const NOW = new Date('2026-11-03T10:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

const access = (role: OrgRole = 'admin', tier = 'self_hosted'): AccessContext =>
  grantAccess({
    organizationId: ORG,
    userId: USER,
    sessionId: SESSION,
    role,
    defaultProjectRole: null,
    tier,
    authenticatedAt: AUTHENTICATED_AT,
  });

// The person invited, signed in.
const guest = () => sessionInfo({ email: ADDRESS });

// Statements that change rows. The organization lock is a select, even though it says update.
const writesOf = (scripted: ScriptedStore) =>
  scripted.statements().filter((s) => /^(insert|update|delete)\b/.test(s.sql));

const has = (s: Statement, verb: string, table: string) =>
  s.sql.startsWith(`${verb} `) && s.sql.includes(`"${table}"`);
const isCount = (s: Statement) => s.sql.includes('count(*)');
const isOrgLock = (s: Statement) =>
  has(s, 'select', 'organizations') && s.sql.endsWith('for update');
const isMemberByAddress = (s: Statement) =>
  has(s, 'select', 'memberships') && s.sql.includes('"u"."email" = $');
const isActor = (s: Statement) =>
  has(s, 'select', 'memberships') && s.sql.includes('"display_name"');
const isInviter = (s: Statement) =>
  has(s, 'select', 'memberships') && !isActor(s) && !isMemberByAddress(s);
const isBlockRead = (s: Statement) => has(s, 'select', 'invitation_blocks');
const isUpsert = (s: Statement) => has(s, 'insert into', 'invitations');
const isProof = (s: Statement) =>
  has(s, 'select', 'invitations') && s.sql.includes('"secret_hash"') && !isCount(s);
const isTier = (s: Statement) => has(s, 'select', 'organizations') && !isOrgLock(s) && !isCount(s);
const isMemberInsert = (s: Statement) => has(s, 'insert into', 'memberships');
const isInvitationDelete = (s: Statement) => has(s, 'delete from', 'invitations');
const isBlockInsert = (s: Statement) => has(s, 'insert into', 'invitation_blocks');
const isRecentRead = (s: Statement) => has(s, 'select', 'sessions');
const isOwnersRead = (s: Statement) =>
  has(s, 'select', 'memberships') && s.sql.includes('"m"."role" = ');

interface World {
  readonly tier?: string;
  readonly actorRole?: OrgRole | null;
  readonly memberByAddress?: boolean;
  readonly blocked?: boolean;
  readonly used?: number;
  readonly displayName?: string | null;
  readonly organizationName?: string;
  readonly invitation?: Record<string, unknown> | null;
  readonly inviterRole?: OrgRole | null;
  readonly memberInserted?: boolean;
  readonly recent?: boolean;
  readonly sessionFound?: boolean;
  // Every owner row after the insert, the person accepting included.
  readonly owners?: readonly Record<string, unknown>[];
}

function invitationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: INV,
    email_normalized: ADDRESS,
    role: 'member',
    default_project_role: 'editor',
    invited_by: INVITER_MEMBERSHIP,
    secret_hash: sha(SECRET),
    live: true,
    ...overrides,
  };
}

// Answers each statement the way Postgres would for the world described.
function world(w: World = {}): Responder {
  return (s) => {
    if (isRecentRead(s)) return w.sessionFound === false ? [] : [{ recent: w.recent ?? true }];
    if (isOwnersRead(s)) return w.owners ?? [];
    if (isCount(s)) return [{ used: w.used ?? 1, plan_tier: w.tier ?? 'self_hosted' }];
    if (isOrgLock(s) || isTier(s)) {
      return [{ plan_tier: w.tier ?? 'self_hosted', name: w.organizationName ?? 'Acme Widgets' }];
    }
    if (isMemberByAddress(s)) return w.memberByAddress === true ? [{ id: NEW_MEMBERSHIP }] : [];
    if (isActor(s)) {
      const role = w.actorRole === undefined ? 'admin' : w.actorRole;
      const displayName = w.displayName === undefined ? 'Ada Admin' : w.displayName;
      return role === null ? [] : [{ id: ACTOR_MEMBERSHIP, role, display_name: displayName }];
    }
    if (isInviter(s)) {
      const role = w.inviterRole === undefined ? 'admin' : w.inviterRole;
      return role === null ? [] : [{ role }];
    }
    if (isBlockRead(s)) return w.blocked === true ? [{ id: 'b' }] : [];
    if (isUpsert(s)) return [{ id: INV, send_count: 1, expires_at: EXPIRES }];
    if (isProof(s)) {
      const row = w.invitation === undefined ? invitationRow() : w.invitation;
      return row === null ? [] : [row];
    }
    if (isMemberInsert(s)) return w.memberInserted === false ? [] : [{ id: NEW_MEMBERSHIP }];
    return [];
  };
}

function mailer() {
  const sent: { to: string; invitation: InvitationSend }[] = [];
  const notices: { to: string; notice: AuthSecurityNotice }[] = [];
  let failNotices = 0;
  let fail = false;
  return {
    sent,
    notices,
    failNextNotice() {
      failNotices += 1;
    },
    failNext() {
      fail = true;
    },
    mailer: {
      sendSecurityNotice(to: string, notice: AuthSecurityNotice) {
        if (failNotices > 0) {
          failNotices -= 1;
          return Promise.reject(new Error(`smtp refused ${to}`));
        }
        notices.push({ to, notice });
        return Promise.resolve();
      },
      sendInvitation(to: string, invitation: InvitationSend) {
        if (fail) {
          fail = false;
          return Promise.reject(new Error(`smtp refused ${to}`));
        }
        sent.push({ to, invitation });
        return Promise.resolve();
      },
    },
  };
}

function setup(
  respond: Responder = world(),
  extra: Partial<InvitationsDeps> = {},
  cfg: AuthConfig = config,
) {
  const scripted = scriptedStore(respond);
  const { logger, lines } = capturingLogger();
  const limiter = noopLimiter();
  const mail = mailer();
  const invitations = createInvitations(cfg, {
    db: {} as Database,
    authDb: {} as AuthDatabase,
    logger,
    limiter,
    mailer: mail.mailer,
    store: scripted.store,
    random: (n) => Buffer.alloc(n, 5),
    now: () => NOW,
    ...extra,
  });
  return { invitations, scripted, lines, limiter, mail };
}

const failed = (result: { ok: true; value: unknown } | { ok: false; error: AuthError }) => {
  if (result.ok) throw new Error('expected a failure');
  return result.error;
};

const input = (overrides: Record<string, unknown> = {}) =>
  ({ email: ADDRESS, role: 'member', defaultProjectRole: 'editor', ...overrides }) as {
    email: string;
    role: OrgRole;
    defaultProjectRole: 'editor' | 'viewer' | null;
  };

const token = (secret: Uint8Array = SECRET) =>
  formatInvitationToken({ organizationId: ORG, invitationId: INV, secret });

function blockTokenFor(cfg: AuthConfig, expiresAt = NOW_SECONDS + 3600) {
  const emailHmac = cfg.invitationBlocks.emailMac(ORG, ADDRESS);
  const tag = cfg.invitationBlocks.linkTag({
    organizationId: ORG,
    invitationId: INV,
    emailHmac,
    expiresAt,
  });
  return formatBlockToken({ organizationId: ORG, invitationId: INV, emailHmac, expiresAt, tag });
}

const otherBlockKey = () =>
  parseAuthConfig({
    ...validEnv(),
    DREFYN_AUTH_INVITATION_BLOCK_KEY: base64url(new Uint8Array(32).fill(12)),
  });

describe('invite', () => {
  it('refuses a person without org.manage_members before any statement or count', async () => {
    const { invitations, scripted, limiter } = setup();
    expect(failed(await invitations.invite(access('member'), input())).code).toBe('AUTH_FORBIDDEN');
    expect(scripted.statements()).toEqual([]);
    expect(limiter.calls).toEqual([]);
  });

  it('applies canAssign over every role pair: an admin never invites an owner', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ORG_ROLES),
        fc.constantFrom(...ORG_ROLES),
        async (actor, target) => {
          const { invitations, scripted } = setup(world({ actorRole: actor }));
          const result = await invitations.invite(access(actor), input({ role: target }));
          const allowed = canAssign(actor, target);
          expect(result.ok).toBe(allowed);
          if (!allowed) {
            expect(failed(result).code).toBe('AUTH_FORBIDDEN');
            expect(writesOf(scripted)).toEqual([]);
          }
          if (actor === 'admin' && target === 'owner') expect(result.ok).toBe(false);
        },
      ),
      runs,
    );
  });

  it('checks the role stored now, so a demotion since the guard ran refuses', async () => {
    const demoted = setup(world({ actorRole: 'member' }));
    expect(failed(await demoted.invitations.invite(access('admin'), input())).code).toBe(
      'AUTH_FORBIDDEN',
    );
    expect(writesOf(demoted.scripted)).toEqual([]);
    const gone = setup(world({ actorRole: null }));
    expect(failed(await gone.invitations.invite(access('admin'), input())).code).toBe(
      'AUTH_FORBIDDEN',
    );
    const lowered = setup(world({ actorRole: 'admin' }));
    expect(
      failed(await lowered.invitations.invite(access('owner'), input({ role: 'owner' }))).code,
    ).toBe('AUTH_FORBIDDEN');
  });

  it.each([
    ['a bad address', { email: 'not an address' }],
    ['no address', { email: undefined }],
    ['an unknown role', { role: 'superuser' }],
    ['a project admin default', { defaultProjectRole: 'admin' }],
    ['an unknown default', { defaultProjectRole: 'owner' }],
  ])('refuses %s before any statement or count', async (_, patch) => {
    const { invitations, scripted, limiter } = setup();
    expect(failed(await invitations.invite(access(), input(patch))).code).toBe(
      'AUTH_INPUT_INVALID',
    );
    expect(scripted.statements()).toEqual([]);
    expect(limiter.calls).toEqual([]);
  });

  it('counts the organization, the inviter and the address, in that order, before the work', async () => {
    const { invitations, limiter } = setup();
    const result = await invitations.invite(access(), input({ email: 'NewComer@Example.com' }));
    expect(result.ok).toBe(true);
    expect(limiter.calls).toEqual([
      ['invite_send', [ORG]],
      ['invite_send_user', [USER]],
      ['invite_recipient', [ADDRESS]],
    ]);
  });

  it.each(['invite_send', 'invite_send_user', 'invite_recipient'])(
    'refuses the next invite once %s is full, with nothing sent to the database',
    async (bucket) => {
      const limiter: RateLimiter = {
        keyFor: () => Buffer.alloc(32),
        reserve: (b) =>
          b === bucket
            ? Promise.reject(new AuthError('AUTH_RATE_LIMITED', { retryAfterSeconds: 60 }))
            : Promise.resolve(),
      };
      const { invitations, scripted, mail } = setup(world(), { limiter });
      const error = failed(await invitations.invite(access(), input()));
      expect(error.code).toBe('AUTH_RATE_LIMITED');
      expect(error.retryAfterSeconds).toBe(60);
      expect(scripted.statements()).toEqual([]);
      expect(mail.sent).toEqual([]);
    },
  );

  it('locks the organization first, then reads, counts and writes in one transaction', async () => {
    const { invitations, scripted } = setup();
    const result = await invitations.invite(access(), input());
    if (!result.ok) throw result.error;
    const statements = scripted.statements();
    const kinds = statements.map((s) => {
      if (isOrgLock(s)) return 'lock';
      if (isActor(s)) return 'actor';
      if (isMemberByAddress(s)) return 'member';
      if (isBlockRead(s)) return 'block';
      if (isCount(s)) return 'count';
      if (isUpsert(s)) return 'upsert';
      return s.sql;
    });
    expect(kinds).toEqual(['lock', 'actor', 'member', 'block', 'count', 'upsert']);
    expect(scripted.events.filter((e) => e.kind === 'begin')).toEqual([
      { kind: 'begin', scope: 'organization', organizationId: ORG, actorUserId: USER },
    ]);
    expect(scripted.events.at(-1)).toEqual({ kind: 'commit' });
    for (const s of statements) expect(s.parameters, s.sql).toContain(ORG);
  });

  it('stores only the hash of the secret, never the secret', async () => {
    const { invitations, scripted } = setup();
    await invitations.invite(access(), input());
    const upsert = scripted.statements().find(isUpsert);
    expect(upsert?.parameters).toContainEqual(sha(SECRET));
    for (const p of upsert?.parameters ?? []) {
      if (Buffer.isBuffer(p)) expect(p.equals(SECRET)).toBe(false);
    }
  });

  it('refuses an address that already belongs to a member, with no write', async () => {
    const { invitations, scripted } = setup(world({ memberByAddress: true }));
    expect(failed(await invitations.invite(access(), input())).code).toBe('AUTH_ALREADY_MEMBER');
    expect(writesOf(scripted)).toEqual([]);
    expect(scripted.events.at(-1)).toEqual({ kind: 'rollback' });
  });

  it('tells the admin plainly when the address asked not to be invited, with no row', async () => {
    const { invitations, scripted, mail } = setup(world({ blocked: true }));
    const result = await invitations.invite(access(), input());
    if (!result.ok) throw result.error;
    expect(result.value).toEqual({ kind: 'blocked' });
    expect(writesOf(scripted)).toEqual([]);
    expect(scripted.statements().some(isCount)).toBe(false);
    expect(mail.sent).toEqual([]);
    const read = scripted.statements().find(isBlockRead);
    expect(read?.parameters).toContainEqual(config.invitationBlocks.emailMac(ORG, ADDRESS));
  });

  it('refuses with AUTH_SEAT_LIMIT when one more seat passes the plan, with no write', async () => {
    const seats = Number(limitFor('starter', 'org.seats'));
    const full = setup(world({ tier: 'starter', used: seats }));
    expect(failed(await full.invitations.invite(access('admin', 'starter'), input())).code).toBe(
      'AUTH_SEAT_LIMIT',
    );
    expect(writesOf(full.scripted)).toEqual([]);
    const fits = setup(world({ tier: 'starter', used: seats - 1 }));
    expect((await fits.invitations.invite(access('admin', 'starter'), input())).ok).toBe(true);
  });

  it('reads the tier from the locked row, so a downgrade since sign in counts', async () => {
    const seats = Number(limitFor('free', 'org.seats'));
    const { invitations } = setup(world({ tier: 'free', used: seats }));
    expect(failed(await invitations.invite(access('admin', 'self_hosted'), input())).code).toBe(
      'AUTH_SEAT_LIMIT',
    );
  });

  it('leaves the invited address out of the count, so a resend never needs a second seat', async () => {
    const { invitations, scripted } = setup();
    await invitations.invite(access(), input());
    expect(scripted.statements().find(isCount)?.parameters).toContain(ADDRESS);
  });

  it('returns the invitation and a send that mails both links on the app origin', async () => {
    const { invitations, mail } = setup();
    const result = await invitations.invite(access(), input());
    if (!result.ok) throw result.error;
    if (result.value.kind !== 'sent') throw new Error('expected sent');
    expect(result.value.invitation).toEqual({
      invitationId: INV,
      organizationId: ORG,
      email: ADDRESS,
      role: 'member',
      defaultProjectRole: 'editor',
      expiresAt: EXPIRES,
    });
    expect(mail.sent).toEqual([]);
    await result.value.send();
    const [sent] = mail.sent;
    if (sent === undefined) throw new Error('nothing sent');
    expect(mail.sent).toHaveLength(1);
    expect(sent.to).toBe(ADDRESS);
    const { invitation } = sent;
    expect(invitation).toMatchObject({
      organizationId: ORG,
      invitationId: INV,
      sendCount: 1,
      organizationName: 'Acme Widgets',
      inviterName: 'Ada Admin',
      expiresAt: EXPIRES,
    });
    expect(invitation.link.origin).toBe(config.appOrigin);
    expect(invitation.link.pathname).toBe('/invite');
    expect(parseInvitationToken(invitation.link.hash.slice(1))).toEqual({
      organizationId: ORG,
      invitationId: INV,
      secret: SECRET,
    });
    expect(invitation.blockLink.origin).toBe(config.appOrigin);
    expect(invitation.blockLink.pathname).toBe('/invite/block');
    const block = parseBlockToken(invitation.blockLink.hash.slice(1));
    expect(block?.organizationId).toBe(ORG);
    expect(block?.invitationId).toBe(INV);
    expect(block?.emailHmac.equals(config.invitationBlocks.emailMac(ORG, ADDRESS))).toBe(true);
    // The block link outlives the invitation: thirty days from now.
    expect(block?.expiresAt).toBe(NOW_SECONDS + 30 * 86_400);
  });

  it('keeps sending quiet: a mail failure never throws and logs ids only', async () => {
    const { invitations, mail, lines } = setup();
    const result = await invitations.invite(access(), input());
    if (!result.ok || result.value.kind !== 'sent') throw new Error('expected sent');
    mail.failNext();
    await expect(result.value.send()).resolves.toBeUndefined();
    expect(lines.at(-1)).toMatchObject({ event: 'auth.invitation_send_failed' });
    expect(JSON.stringify(lines)).not.toContain('example.com');
  });

  it('logs the invitation with ids only, never the address or a token', async () => {
    const { invitations, lines } = setup();
    const result = await invitations.invite(access(), input());
    if (!result.ok || result.value.kind !== 'sent') throw new Error('expected sent');
    await result.value.send();
    const text = JSON.stringify(lines);
    expect(text).toContain('auth.invitation_created');
    expect(text).toContain('org_');
    expect(text).not.toContain('newcomer');
    expect(text).not.toContain(token());
  });

  it('answers AUTH_UNAVAILABLE when the database fails, and logs it', async () => {
    const { invitations, lines } = setup(() => {
      throw new Error('connection reset');
    });
    expect(failed(await invitations.invite(access(), input())).code).toBe('AUTH_UNAVAILABLE');
    expect(lines.at(-1)).toMatchObject({ event: 'auth.invitation_create_failed' });
  });
});

describe('acceptInvitation proves the token first (M5)', () => {
  it('refuses a malformed token with no statement at all', async () => {
    for (const value of ['', 'x', `${token()}x`, token().replace('.', '/')]) {
      const { invitations, scripted } = setup();
      expect(failed(await invitations.acceptInvitation(guest(), value)).code).toBe(
        'AUTH_INVITATION_INVALID',
      );
      expect(scripted.statements()).toEqual([]);
    }
    const { invitations, scripted } = setup();
    const url = new URL(`https://app.drefyn.test/invite#${token()}`) as unknown as string;
    expect(failed(await invitations.acceptInvitation(guest(), url)).code).toBe(
      'AUTH_INVITATION_INVALID',
    );
    expect(scripted.statements()).toEqual([]);
  });

  it.each([
    ['a wrong secret', invitationRow(), Buffer.alloc(32, 6)],
    ['a missing row', null, SECRET],
    ['an expired invitation', invitationRow({ live: false }), SECRET],
  ])('sends exactly one statement and no write for %s', async (_, row, secret) => {
    const { invitations, scripted } = setup(world({ invitation: row }));
    expect(failed(await invitations.acceptInvitation(guest(), token(secret))).code).toBe(
      'AUTH_INVITATION_INVALID',
    );
    expect(scripted.statements()).toHaveLength(1);
    expect(scripted.statements()[0]?.parameters).toEqual(expect.arrayContaining([INV, ORG]));
    expect(writesOf(scripted)).toEqual([]);
    // The membership is born for the person accepting, which the database checks.
    expect(scripted.events[0]).toEqual({
      kind: 'begin',
      scope: 'organization',
      organizationId: ORG,
      actorUserId: USER,
    });
    expect(scripted.events.at(-1)).toEqual({ kind: 'rollback' });
  });

  it('refuses another address after the proof, before anything else', async () => {
    const { invitations, scripted } = setup();
    const result = await invitations.acceptInvitation(
      sessionInfo({ email: 'someone.else@example.com' }),
      token(),
    );
    expect(failed(result).code).toBe('AUTH_INVITATION_EMAIL_MISMATCH');
    expect(scripted.statements()).toHaveLength(1);
    expect(writesOf(scripted)).toEqual([]);
  });

  it('compares the address after normalisation', async () => {
    const { invitations } = setup();
    const result = await invitations.acceptInvitation(
      sessionInfo({ email: 'NewComer@Example.COM' }),
      token(),
    );
    expect(result.ok).toBe(true);
  });

  it.each([
    ['removed', null, 'member'],
    ['demoted to member', 'member', 'member'],
    ['an admin who invited an owner', 'admin', 'owner'],
  ] as const)('refuses when the inviter was %s', async (_, inviterRole, role) => {
    const { invitations, scripted } = setup(
      world({ inviterRole, invitation: invitationRow({ role }) }),
    );
    expect(failed(await invitations.acceptInvitation(guest(), token())).code).toBe(
      'AUTH_INVITATION_INVALID',
    );
    expect(writesOf(scripted)).toEqual([]);
  });

  it('inserts the membership from the invitation, then deletes the invitation', async () => {
    const { invitations, scripted, lines } = setup(
      world({ invitation: invitationRow({ role: 'admin', default_project_role: null }) }),
    );
    const result = await invitations.acceptInvitation(guest(), token());
    if (!result.ok) throw result.error;
    expect(result.value.access).toMatchObject({ organizationId: ORG, userId: USER, role: 'admin' });
    expect(result.value.access.permissions).toContain('org.manage_members');
    const order = scripted.statements().map((s) => {
      if (isProof(s)) return 'proof';
      if (isInviter(s)) return 'inviter';
      if (isTier(s)) return 'tier';
      if (isMemberInsert(s)) return 'insert';
      if (isInvitationDelete(s)) return 'delete';
      return s.sql;
    });
    expect(order).toEqual(['proof', 'inviter', 'tier', 'insert', 'delete']);
    const insert = scripted.statements().find(isMemberInsert);
    expect(insert?.parameters).toEqual(expect.arrayContaining([ORG, USER, 'admin', INV]));
    expect(scripted.events.at(-1)).toEqual({ kind: 'commit' });
    expect(JSON.stringify(lines)).toContain('auth.invitation_accepted');
    expect(JSON.stringify(lines)).not.toContain('newcomer');
  });

  it('answers AUTH_ALREADY_MEMBER and keeps the invitation when the person already belongs', async () => {
    const { invitations, scripted } = setup(world({ memberInserted: false }));
    expect(failed(await invitations.acceptInvitation(guest(), token())).code).toBe(
      'AUTH_ALREADY_MEMBER',
    );
    expect(scripted.statements().some(isInvitationDelete)).toBe(false);
    expect(scripted.events.at(-1)).toEqual({ kind: 'rollback' });
  });

  it('answers AUTH_UNAVAILABLE when the database fails', async () => {
    const { invitations } = setup(() => {
      throw new Error('down');
    });
    expect(failed(await invitations.acceptInvitation(guest(), token())).code).toBe(
      'AUTH_UNAVAILABLE',
    );
  });
});

describe('the block link', () => {
  it('reads the organization name for the page with select statements only', async () => {
    const { invitations, scripted } = setup();
    const result = await invitations.readInvitationBlock(blockTokenFor(config));
    if (!result.ok) throw result.error;
    expect(result.value).toEqual({ organizationId: ORG, organizationName: 'Acme Widgets' });
    expect(scripted.statements().length).toBeGreaterThan(0);
    for (const s of scripted.statements()) expect(s.sql).toMatch(/^select /);
    expect(writesOf(scripted)).toEqual([]);
  });

  it.each([
    ['a forged tag', () => blockTokenFor(otherBlockKey())],
    ['an expired link', () => blockTokenFor(config, NOW_SECONDS - 1)],
    ['a malformed token', () => 'not-a-token'],
  ])('refuses %s with no statement, for reads and blocks alike', async (_, make) => {
    const { invitations, scripted } = setup();
    expect(failed(await invitations.readInvitationBlock(make())).code).toBe(
      'AUTH_INVITATION_INVALID',
    );
    expect(failed(await invitations.blockInvitation(make())).code).toBe('AUTH_INVITATION_INVALID');
    expect(scripted.statements()).toEqual([]);
  });

  it('blocks by the address HMAC and drops the pending invitation', async () => {
    const { invitations, scripted, lines } = setup();
    expect(await invitations.blockInvitation(blockTokenFor(config))).toEqual({
      ok: true,
      value: undefined,
    });
    const insert = scripted.statements().find(isBlockInsert);
    expect(insert?.parameters).toEqual(
      expect.arrayContaining([ORG, config.invitationBlocks.emailMac(ORG, ADDRESS)]),
    );
    const drop = scripted.statements().find(isInvitationDelete);
    expect(drop?.parameters).toEqual(expect.arrayContaining([ORG, INV]));
    expect(JSON.stringify(lines)).toContain('auth.invitation_blocked');
  });

  it('treats a second block with the same token as a no op that still succeeds', async () => {
    // on conflict do nothing returns no row the second time.
    const { invitations } = setup(() => []);
    expect(await invitations.blockInvitation(blockTokenFor(config))).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it('answers AUTH_UNAVAILABLE when the database fails', async () => {
    const { invitations } = setup(() => {
      throw new Error('down');
    });
    expect(failed(await invitations.blockInvitation(blockTokenFor(config))).code).toBe(
      'AUTH_UNAVAILABLE',
    );
    expect(failed(await invitations.readInvitationBlock(blockTokenFor(config))).code).toBe(
      'AUTH_UNAVAILABLE',
    );
  });

  it('still matches after DREFYN_AUTH_SECRET is rotated', async () => {
    const rotated = parseAuthConfig({
      ...validEnv(base64url(new Uint8Array(32).fill(21))),
      DREFYN_AUTH_SECRET_PREVIOUS: base64url(new Uint8Array(32).fill(7)),
    });
    expect(
      rotated.invitationBlocks
        .emailMac(ORG, ADDRESS)
        .equals(config.invitationBlocks.emailMac(ORG, ADDRESS)),
    ).toBe(true);
    const { invitations } = setup(world(), {}, rotated);
    expect((await invitations.blockInvitation(blockTokenFor(config))).ok).toBe(true);
  });

  it('is written by blockInvitation alone', async () => {
    type Work = (i: ReturnType<typeof setup>['invitations']) => Promise<unknown>;
    const cases: [string, Responder, Work][] = [
      ['invite', world(), (i) => i.invite(access(), input())],
      ['invite blocked', world({ blocked: true }), (i) => i.invite(access(), input())],
      ['accept', world(), (i) => i.acceptInvitation(guest(), token())],
      ['read block', world(), (i) => i.readInvitationBlock(blockTokenFor(config))],
      ['seats', world(), (i) => i.seatUsage(access())],
      ['block', world(), (i) => i.blockInvitation(blockTokenFor(config))],
    ];
    for (const [name, respond, work] of cases) {
      const { invitations, scripted } = setup(respond);
      await work(invitations);
      const touches = writesOf(scripted).some((s) => s.sql.includes('"invitation_blocks"'));
      expect(touches, name).toBe(name === 'block');
    }
    const src = join(import.meta.dirname, '..', 'src');
    const source = readFileSync(join(src, 'invitations.ts'), 'utf8');
    expect(source.match(/insertInto\('invitation_blocks'\)/g)).toHaveLength(1);
    expect(source).not.toMatch(/(updateTable|deleteFrom)\('invitation_blocks'\)/);
  });
});

describe('seatUsage', () => {
  it('counts memberships and live invitations of the organization, with the plan limit', async () => {
    const { invitations, scripted } = setup(world({ tier: 'starter', used: 3 }));
    expect(await invitations.seatUsage(access('member', 'starter'))).toEqual({
      used: 3,
      limit: limitFor('starter', 'org.seats'),
    });
    expect(writesOf(scripted)).toEqual([]);
    for (const s of scripted.statements()) expect(s.parameters).toContain(ORG);
  });

  it('throws AUTH_UNAVAILABLE when the database fails', async () => {
    const { invitations } = setup(() => {
      throw new Error('down');
    });
    await expect(invitations.seatUsage(access())).rejects.toMatchObject({
      code: 'AUTH_UNAVAILABLE',
    });
  });
});

// Inviting an owner is a way to add one, so it answers to the same rule as a role change.
describe('inviting an owner', () => {
  const owner = () => input({ role: 'owner' });
  const organizationBegins = (scripted: ScriptedStore) =>
    scripted.events.filter((e) => e.kind === 'begin' && e.scope === 'organization');

  it('refuses a stale sign in before the limiter or any write', async () => {
    const { invitations, scripted, limiter, mail } = setup(
      world({ actorRole: 'owner', recent: false }),
    );
    const result = await invitations.invite(access('owner'), owner());
    expect(failed(result).code).toBe('AUTH_RECENT_AUTH_REQUIRED');
    expect(scripted.statements().map(isRecentRead)).toEqual([true]);
    expect(limiter.calls).toEqual([]);
    expect(organizationBegins(scripted)).toEqual([]);
    expect(mail.sent).toEqual([]);
  });

  it('refuses a session that has gone', async () => {
    const { invitations, limiter } = setup(world({ actorRole: 'owner', sessionFound: false }));
    const result = await invitations.invite(access('owner'), owner());
    expect(failed(result).code).toBe('AUTH_SESSION_INVALID');
    expect(limiter.calls).toEqual([]);
  });

  it('checks by database time, for this session and person, then carries on', async () => {
    const { invitations, scripted } = setup(world({ actorRole: 'owner' }));
    const result = await invitations.invite(access('owner'), owner());
    expect(result.ok).toBe(true);
    const [first] = scripted.statements();
    expect(first?.sql).toContain("authenticated_at > now() - interval '15 minutes'");
    expect(first?.sql).toContain('app.current_user_id()');
    expect(first?.parameters).toContain(SESSION);
    expect(scripted.statements().some(isUpsert)).toBe(true);
  });

  it('refuses an admin as before, with no sign in check', async () => {
    const { invitations, scripted } = setup();
    expect(failed(await invitations.invite(access('admin'), owner())).code).toBe('AUTH_FORBIDDEN');
    expect(scripted.statements()).toEqual([]);
  });

  it.each(['admin', 'member'])('leaves a %s invitation unchanged, stale or not', async (role) => {
    const { invitations, scripted } = setup(world({ actorRole: 'owner', recent: false }));
    expect((await invitations.invite(access('owner'), input({ role }))).ok).toBe(true);
    expect(scripted.statements().some(isRecentRead)).toBe(false);
  });
});

describe('accepting an owner invitation', () => {
  const AT = new Date('2026-11-04T09:00:00.000Z');
  const row = (id: string, email: string, display_name: string | null = null) => ({
    id,
    email,
    display_name,
    at: AT,
  });
  const owners = [
    row(USER, ADDRESS, 'Nia Newcomer'),
    row('01890a5d-ac96-774b-bcce-b302099a8091', 'one@example.com', 'One'),
    row('01890a5d-ac96-774b-bcce-b302099a8092', 'two@example.com'),
  ];
  const acceptWorld = (w: World = {}) =>
    world({ inviterRole: 'owner', invitation: invitationRow({ role: 'owner' }), owners, ...w });

  it('tells every existing owner after the commit, and not the new owner', async () => {
    const { invitations, scripted, mail } = setup(acceptWorld());
    const result = await invitations.acceptInvitation(guest(), token());
    if (!result.ok) throw result.error;
    expect(result.value.access.role).toBe('owner');
    const notice = {
      kind: 'owner_added',
      organizationId: ORG,
      membershipId: idOf('mem', NEW_MEMBERSHIP),
      memberName: 'Nia Newcomer',
      at: AT,
    };
    expect(mail.notices).toEqual([
      { to: 'one@example.com', notice },
      { to: 'two@example.com', notice },
    ]);
    expect(scripted.events.at(-1)).toEqual({ kind: 'commit' });
    const order = scripted.statements();
    expect(order.findIndex(isMemberInsert)).toBeLessThan(order.findIndex(isOwnersRead));
  });

  it('names the new owner by address when they set no name', async () => {
    const { invitations, mail } = setup(
      acceptWorld({
        owners: [
          row(USER, ADDRESS),
          row('01890a5d-ac96-774b-bcce-b302099a8091', 'one@example.com'),
        ],
      }),
    );
    await invitations.acceptInvitation(guest(), token());
    expect(mail.notices[0]?.notice).toMatchObject({ memberName: ADDRESS });
  });

  it('still tells the others when one send fails, and keeps the acceptance', async () => {
    const { invitations, mail, lines } = setup(acceptWorld());
    mail.failNextNotice();
    const result = await invitations.acceptInvitation(guest(), token());
    expect(result.ok).toBe(true);
    expect(mail.notices.map((n) => n.to)).toEqual(['two@example.com']);
    const failures = lines.filter((l) => l.event === 'auth.member_notice_failed');
    expect(failures).toHaveLength(1);
    expect(JSON.stringify(failures)).not.toContain('@example.com');
  });

  it.each(['admin', 'member'])('reads no owners and tells nobody for a new %s', async (role) => {
    const { invitations, scripted, mail } = setup(
      world({ inviterRole: 'owner', invitation: invitationRow({ role }), owners }),
    );
    expect((await invitations.acceptInvitation(guest(), token())).ok).toBe(true);
    expect(scripted.statements().some(isOwnersRead)).toBe(false);
    expect(mail.notices).toEqual([]);
  });
});

describe('readInvitation', () => {
  const rowFor = (overrides: Record<string, unknown> = {}) => ({
    ...invitationRow(overrides),
    expires_at: EXPIRES,
  });

  function reading(w: World = {}) {
    const scripted = scriptedStore((s) => {
      if (isProof(s)) {
        return w.invitation === null ? [] : [{ ...rowFor(), ...(w.invitation ?? {}) }];
      }
      if (has(s, 'select', 'memberships')) {
        return [{ display_name: w.displayName === undefined ? 'Ada Admin' : w.displayName }];
      }
      if (has(s, 'select', 'organizations')) {
        return w.organizationName === null ? [] : [{ name: w.organizationName ?? 'Acme Widgets' }];
      }
      return [];
    });
    const { logger } = capturingLogger();
    const invitations = createInvitations(config, {
      db: {} as Database,
      authDb: {} as AuthDatabase,
      logger,
      mailer: {
        sendInvitation: () => Promise.resolve(),
        sendSecurityNotice: () => Promise.resolve(),
      },
      limiter: noopLimiter(),
      store: scripted.store,
    });
    return { invitations, scripted };
  }

  const token = () =>
    formatInvitationToken({ organizationId: ORG, invitationId: INV, secret: SECRET });

  it('shows the person holding the token what they were invited to', async () => {
    const { invitations } = reading();
    const read = await invitations.readInvitation(token());
    if (!read.ok) throw read.error;
    expect(read.value).toMatchObject({
      organizationId: ORG,
      organizationName: 'Acme Widgets',
      inviterName: 'Ada Admin',
      email: ADDRESS,
      role: 'member',
      defaultProjectRole: 'editor',
      expiresAt: EXPIRES,
    });
    expect(read.value.blockLink.pathname).toBe('/invite/block');
    expect(read.value.blockLink.search).toBe('');
    expect(parseBlockToken(read.value.blockLink.hash.slice(1))).not.toBeNull();
  });

  it('never prints a display name that a mail client would link', async () => {
    const { invitations } = reading({ displayName: 'click evil.example now' });
    const read = await invitations.readInvitation(token());
    expect(read).toMatchObject({ ok: true, value: { inviterName: 'A team member' } });
  });

  it.each([
    ['a token of the wrong shape', 'nope', {}],
    ['an invitation that is gone', null, { invitation: null }],
    ['a dead invitation', null, { invitation: { live: false } }],
    ['a wrong secret', null, { invitation: { secret_hash: Buffer.alloc(32, 7) } }],
    ['an organization that is gone', null, { organizationName: null }],
  ] as const)('answers invalid for %s', async (_name, raw, w) => {
    const { invitations } = reading(w as World);
    const read = await invitations.readInvitation(raw ?? token());
    expect(read).toMatchObject({ ok: false, error: { code: 'AUTH_INVITATION_INVALID' } });
  });

  it('reads and writes nothing', async () => {
    const { invitations, scripted } = reading();
    await invitations.readInvitation(token());
    expect(writesOf(scripted)).toEqual([]);
  });

  it('answers unavailable when the read fails', async () => {
    const scripted = scriptedStore(() => {
      throw new Error('connection reset');
    });
    const { logger } = capturingLogger();
    const invitations = createInvitations(config, {
      db: {} as Database,
      authDb: {} as AuthDatabase,
      logger,
      mailer: {
        sendInvitation: () => Promise.resolve(),
        sendSecurityNotice: () => Promise.resolve(),
      },
      limiter: noopLimiter(),
      store: scripted.store,
    });
    const read = await invitations.readInvitation(token());
    expect(read).toMatchObject({ ok: false, error: { code: 'AUTH_UNAVAILABLE' } });
  });
});

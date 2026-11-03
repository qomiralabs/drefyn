import type { AuthDatabase, Database } from '@drefyn/db';
import { idOf, type OrganizationId } from '@drefyn/tenancy';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  INVITE_MAX_AGE_SECONDS,
  createInvitations,
  formatInvitationToken,
  parseAuthConfig,
  parseInvitationToken,
  serializeCookie,
  type AuthConfig,
  type InvitationsDeps,
  type PendingInvitations,
} from '../src/index.ts';
import { scriptedStore, isWrite, type Responder, type Statement } from './scripted-store.ts';
import {
  browser,
  capturingLogger,
  config,
  noopLimiter,
  sessionInfo,
  sha,
} from './session-fixtures.ts';
import { runs, secretBytes, validEnv } from './support.ts';

const ORG: OrganizationId = idOf('org', '01890a5d-ac96-774b-bcce-b302099a8070');
const OTHER_ORG: OrganizationId = idOf('org', '01890a5d-ac96-774b-bcce-b302099a8079');
const INV = idOf('inv', '01890a5d-ac96-774b-bcce-b302099a8072');
const INVITER_MEMBERSHIP = '01890a5d-ac96-774b-bcce-b302099a8073';
const NEW_MEMBERSHIP = '01890a5d-ac96-774b-bcce-b302099a8074';
const ADDRESS = 'newcomer@example.com';
const SECRET = Buffer.alloc(32, 5);

const token = (secret: Uint8Array = SECRET, organizationId: OrganizationId = ORG) =>
  formatInvitationToken({ organizationId, invitationId: INV, secret });

const isProof = (s: Statement) =>
  /^select\b/.test(s.sql) && s.sql.includes('"invitations"') && s.sql.includes('"secret_hash"');

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: INV,
    email_normalized: ADDRESS,
    role: 'member',
    default_project_role: null,
    invited_by: INVITER_MEMBERSHIP,
    secret_hash: sha(SECRET),
    live: true,
    ...overrides,
  };
}

// Answers the proof with the row given, scoped the way RLS would: only in its organization.
function database(found: Record<string, unknown> | null = row(), home: OrganizationId = ORG) {
  return (s: Statement) => {
    if (isProof(s)) return found !== null && s.parameters.includes(home) ? [found] : [];
    if (/^select\b/.test(s.sql) && s.sql.includes('"memberships"')) return [{ role: 'admin' }];
    if (/^select\b/.test(s.sql) && s.sql.includes('"organizations"')) {
      return [{ plan_tier: 'self_hosted' }];
    }
    if (s.sql.startsWith('insert into "memberships"')) return [{ id: NEW_MEMBERSHIP }];
    return [];
  };
}

function setup(respond: Responder = database(), cfg: AuthConfig = config) {
  const scripted = scriptedStore(respond);
  const { logger, lines } = capturingLogger();
  const deps: InvitationsDeps = {
    db: {} as Database,
    authDb: {} as AuthDatabase,
    logger,
    limiter: noopLimiter(),
    mailer: { sendInvitation: () => Promise.resolve() },
    store: scripted.store,
  };
  return { invitations: createInvitations(cfg, deps), scripted, lines };
}

describe('holdInvitation', () => {
  it('sets the invite cookie with the exact attributes', () => {
    const { invitations, scripted } = setup();
    const held = invitations.holdInvitation(browser(), token());
    if (!held.ok) throw held.error;
    expect(held.value.setCookies).toEqual([
      { name: config.cookies.invite, value: token(), maxAgeSeconds: 3600 },
    ]);
    expect(INVITE_MAX_AGE_SECONDS).toBe(3600);
    const header = serializeCookie(
      config,
      held.value.setCookies[0] ?? { name: '', value: '', maxAgeSeconds: 0 },
    );
    expect(header).toBe(
      `__Host-drefyn_invite=${token()}; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax`,
    );
    expect(scripted.events).toEqual([]);
  });

  it('refuses a malformed token with AUTH_INVITATION_INVALID and no cookie', () => {
    const { invitations, scripted } = setup();
    const url = new URL(`https://app.drefyn.test/invite#${token()}`) as unknown as string;
    for (const value of [
      '',
      'x',
      `${token()}x`,
      token().replace('.', '/'),
      token().slice(1),
      url,
    ]) {
      const held = invitations.holdInvitation(browser(), value);
      expect(held.ok ? null : held.error.code).toBe('AUTH_INVITATION_INVALID');
    }
    expect(scripted.events).toEqual([]);
  });

  it('only ever holds a token that parses, for any string', () => {
    const { invitations } = setup();
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.string({ unit: 'binary' })), (value) => {
        const held = invitations.holdInvitation(browser(), value);
        if (parseInvitationToken(value) === null) {
          return !held.ok && held.error.code === 'AUTH_INVITATION_INVALID';
        }
        return held.ok && held.value.setCookies[0]?.value === value;
      }),
      runs,
    );
  });

  it('holds any well formed token as is', () => {
    const { invitations } = setup();
    fc.assert(
      fc.property(secretBytes, (secret) => {
        const value = token(secret);
        const held = invitations.holdInvitation(browser(), value);
        return held.ok && held.value.setCookies[0]?.value === value;
      }),
      runs,
    );
  });
});

describe('acceptInvitation clears the held invitation', () => {
  it('returns a zero Max-Age invite cookie with the access', async () => {
    const { invitations } = setup();
    const accepted = await invitations.acceptInvitation(sessionInfo({ email: ADDRESS }), token());
    if (!accepted.ok) throw accepted.error;
    expect(accepted.value.access.organizationId).toBe(ORG);
    expect(accepted.value.setCookies).toEqual([
      { name: config.cookies.invite, value: '', maxAgeSeconds: 0 },
    ]);
  });
});

describe('allowsSignUp', () => {
  it('is the PendingInvitations port', () => {
    const { invitations } = setup();
    const port: PendingInvitations = invitations;
    expect(typeof port.allowsSignUp).toBe('function');
  });

  it('says no without touching the database when there is no cookie or it does not parse', async () => {
    for (const value of [null, '', 'x', `${token()}x`, token().replace('.', '/')]) {
      const { invitations, scripted } = setup();
      expect(await invitations.allowsSignUp(value, ADDRESS)).toBe(false);
      expect(scripted.events).toEqual([]);
    }
  });

  it('sends exactly one select by invitation id in the token organization, and no write', async () => {
    const { invitations, scripted } = setup();
    expect(await invitations.allowsSignUp(token(), ADDRESS)).toBe(true);
    expect(scripted.events[0]).toEqual({
      kind: 'begin',
      scope: 'organization',
      organizationId: ORG,
    });
    const statements = scripted.statements();
    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toMatch(/^select\b/);
    expect(statements[0]?.parameters).toEqual(expect.arrayContaining([INV, ORG]));
    // Never a lookup by address.
    expect(statements[0]?.parameters).not.toContain(ADDRESS);
    expect(statements[0]?.sql).not.toMatch(/"email_normalized" =/);
    expect(statements.filter(isWrite)).toEqual([]);
  });

  it.each([
    ['another address', row({ email_normalized: 'someone.else@example.com' }), SECRET, ORG],
    ['an expired invitation', row({ live: false }), SECRET, ORG],
    ['a missing row (revoked or accepted)', null, SECRET, ORG],
    ['a wrong secret', row(), Buffer.alloc(32, 6), ORG],
    ['an id from another organization', row(), SECRET, OTHER_ORG],
  ] as const)('says no for %s, with one statement and no write', async (_, found, secret, org) => {
    const { invitations, scripted } = setup(database(found));
    expect(await invitations.allowsSignUp(token(secret, org), ADDRESS)).toBe(false);
    expect(scripted.statements()).toHaveLength(1);
    expect(scripted.statements().filter(isWrite)).toEqual([]);
  });

  it('logs the organization and never the token or address when the database is down', async () => {
    const { invitations, lines } = setup(() => {
      throw new Error(`connection lost while reading ${ADDRESS}`);
    });
    expect(await invitations.allowsSignUp(token(), ADDRESS)).toBe(false);
    expect(lines).toEqual([
      {
        event: 'auth.invitation_check_failed',
        fields: { organizationId: `org_${token().slice(0, 26)}` },
      },
    ]);
    const text = JSON.stringify(lines);
    for (const secret of [token(), ADDRESS, 'newcomer', SECRET.toString('hex')]) {
      expect(text).not.toContain(secret);
    }
  });

  it('never lets a random token or address in unless both match the seeded invitation', async () => {
    const cfg = parseAuthConfig(validEnv());
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constant(token()),
          fc.string(),
          secretBytes.map((s) => token(s)),
        ),
        fc.oneof(fc.constant(ADDRESS), fc.emailAddress()),
        async (value, email) => {
          const { invitations } = setup(database(), cfg);
          const allowed = await invitations.allowsSignUp(value, email);
          return allowed === (value === token() && email === ADDRESS);
        },
      ),
      runs,
    );
  });
});

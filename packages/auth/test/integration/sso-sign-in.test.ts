import { randomBytes, randomUUID } from 'node:crypto';
import { idOf, organizationId, type OrganizationId, type UserId } from '@drefyn/tenancy';
import { beforeAll, expect, it } from 'vitest';
import {
  createEmailSignIn,
  formatChallengeId,
  type AuthConfig,
  type AuthLogger,
  type SsoConnectionId,
} from '../../src/index.ts';
import { createSsoSignIn, type SsoCompleted } from '../../src/sso-sign-in.ts';
import { createTestAuthMailer } from '../../src/testing.ts';
import { mintVerifiedIdentity, type VerifiedIdentity } from '../../src/verified-identity.ts';
import { Jar } from '../oauth-fixtures.ts';
import { configWith } from './support/email.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';

const fresh = harness();
let h: Harness;

const hex = () => randomBytes(4).toString('hex');

interface Org {
  readonly organizationId: OrganizationId;
  readonly connectionId: SsoConnectionId;
  readonly domain: string;
  readonly owner: UserId;
}

// Seeded as the superuser: an organization, its owner, one connection the owner made and
// one verified domain. Each case gets its own, so cases never share a seat count.
async function organization(
  options: {
    readonly tier?: string;
    readonly status?: string;
    readonly jit?: boolean;
    readonly projectRole?: 'editor' | 'viewer' | null;
    readonly members?: number;
  } = {},
): Promise<Org> {
  const org = randomUUID();
  const conn = randomUUID();
  const ownerMembership = randomUUID();
  const domain = `d${hex()}.example`;
  const owner = await h.user(`owner-${hex()}@${domain}`);
  const role = options.projectRole ?? null;
  await h.sql(
    `insert into app.organizations (organization_id, name, plan_tier)
       values ('${org}', 'Acme', '${options.tier ?? 'self_hosted'}');
     insert into app.memberships (id, organization_id, user_id, role)
       values ('${ownerMembership}', '${org}', '${owner}', 'owner');
     insert into app.sso_connections (id, organization_id, protocol, status, display_name,
         jit_enabled, jit_default_project_role, created_by, idempotency_key)
       values ('${conn}', '${org}', 'oidc', '${options.status ?? 'active'}', 'Acme Okta',
               ${String(options.jit ?? false)}, ${role === null ? 'null' : `'${role}'`},
               '${ownerMembership}', 'k-${conn}');
     insert into app.sso_domains (organization_id, connection_id, domain, txt_token_hash, verified_at)
       values ('${org}', '${conn}', '${domain}', decode(repeat('ab', 32), 'hex'), now());`,
  );
  for (let i = 1; i < (options.members ?? 1); i += 1) {
    const user = await h.user(`held-${hex()}@${domain}`);
    await h.sql(
      `insert into app.memberships (organization_id, user_id, role)
         values ('${org}', '${user}', 'member');`,
    );
  }
  return {
    organizationId: organizationId(org),
    connectionId: idOf('ssc', conn),
    domain,
    owner,
  };
}

function identity(o: Org, email: string, subject = `sub-${hex()}`): VerifiedIdentity {
  const minted = mintVerifiedIdentity({
    protocol: 'oidc',
    organizationId: o.organizationId,
    connectionId: o.connectionId,
    subject,
    email,
    displayName: 'Ada',
    idpAuthenticatedAt: new Date(),
  });
  if (minted === null) throw new Error('identity fixture refused');
  return minted;
}

function world(env: Readonly<Record<string, string>> = {}) {
  const config: AuthConfig = configWith({ DREFYN_AUTH_SIGNUP: 'open', ...env });
  const logs: { event: string; fields: unknown }[] = [];
  const logger: AuthLogger = {
    info: (event, fields) => logs.push({ event, fields }),
    warn: (event, fields) => logs.push({ event, fields }),
  };
  const mail = createTestAuthMailer();
  const sso = createSsoSignIn(config, { db: h.db, authDb: h.authDb, logger, mailer: mail.mailer });
  const email = createEmailSignIn(config, {
    db: h.db,
    authDb: h.authDb,
    logger,
    mailer: mail.mailer,
    ssoLinks: sso,
  });
  return { config, logs, mail, sso, email };
}

type World = ReturnType<typeof world>;

async function signIn(w: World, who: VerifiedIdentity, jar = new Jar()): Promise<SsoCompleted> {
  const done = await w.sso.signInWithVerifiedIdentity(jar.context(), who, '/acme');
  if (!done.ok) throw done.error;
  if (done.value.kind !== 'refused') jar.apply(done.value.setCookies);
  return done.value;
}

const one = async (text: string) => (await h.sql(text)).trim();

const membersOf = (o: Org) =>
  one(`select count(*) from app.memberships where organization_id = '${o.organizationId}';`);

describeWithStack('SSO sign in against Postgres', () => {
  beforeAll(async () => {
    h = await fresh();
  });

  it('writes a session with method sso and both SSO columns, and adds a member just in time', async () => {
    const w = world();
    const o = await organization({ jit: true, projectRole: 'viewer' });
    const done = await signIn(w, identity(o, `ada@${o.domain}`, 'sub-session'));
    expect(done.kind).toBe('signed_in');
    expect(
      await one(
        `select s.method || ',' || s.sso_connection_id || ',' || s.sso_organization_id
           from app.sessions s join app.users u on u.id = s.user_id
          where u.email_normalized = 'ada@${o.domain}';`,
      ),
    ).toBe(`sso,${o.connectionId},${o.organizationId}`);
    expect(
      await one(
        `select m.role || ',' || m.default_project_role || ',' || (m.invitation_id is null)
           from app.memberships m join app.users u on u.id = m.user_id
          where u.email_normalized = 'ada@${o.domain}';`,
      ),
    ).toBe('member,viewer,true');
    // A second sign in finds the person by subject and marks the link used.
    expect((await signIn(w, identity(o, `renamed@${o.domain}`, 'sub-session'))).kind).toBe(
      'signed_in',
    );
    expect(
      await one(
        `select count(*) || ',' || bool_and(last_used_at is not null) from app.sso_identities
          where organization_id = '${o.organizationId}';`,
      ),
    ).toBe('1,true');
  });

  it('gives an enrolled person factor_required and writes no session', async () => {
    const w = world();
    const o = await organization();
    await h.sql(
      `insert into app.totp_credentials (user_id, key_id, secret_nonce, secret_sealed, confirmed_at)
         values ('${o.owner}', 'k1', decode(repeat('01', 12), 'hex'), decode(repeat('02', 36), 'hex'), now());
       insert into app.sso_identities (organization_id, connection_id, user_id, subject, email_normalized)
         values ('${o.organizationId}', '${o.connectionId}', '${o.owner}', 'sub-owner', 'owner@${o.domain}');`,
    );
    const done = await signIn(w, identity(o, `owner@${o.domain}`, 'sub-owner'));
    expect(done.kind).toBe('factor_required');
    expect(await one(`select count(*) from app.sessions where user_id = '${o.owner}';`)).toBe('0');
  });

  it('gives two concurrent just in time sign ins with one free seat one member and one refusal', async () => {
    const w = world();
    // Free holds five seats; four are taken.
    const o = await organization({ tier: 'free', jit: true, members: 4 });
    const results = await Promise.all(
      ['first', 'second'].map((name) =>
        w.sso.signInWithVerifiedIdentity(
          new Jar().context(),
          identity(o, `${name}@${o.domain}`),
          '/',
        ),
      ),
    );
    const kinds = results.map((r) => (r.ok ? r.value.kind : r.error.code)).sort();
    expect(kinds).toEqual(['refused', 'signed_in']);
    const refusal = results.find((r) => r.ok && r.value.kind === 'refused');
    expect(refusal?.ok === true ? refusal.value : null).toEqual({
      kind: 'refused',
      reason: 'AUTH_SSO_SEAT_LIMIT',
    });
    expect(await membersOf(o)).toBe('5');
  });

  it('leaves a user and link with no membership when the membership insert fails, and a retry completes it', async () => {
    const w = world();
    const o = await organization({ jit: true });
    const who = identity(o, `retry@${o.domain}`, 'sub-retry');
    await h.sql(
      `create function public.sso_fail_membership() returns trigger language plpgsql
         as $$ begin raise exception 'injected membership failure'; end $$;
       create trigger sso_fail_membership before insert on app.memberships
         for each row execute function public.sso_fail_membership();`,
    );
    try {
      const failed = await w.sso.signInWithVerifiedIdentity(new Jar().context(), who, '/');
      expect(failed.ok ? failed.value.kind : failed.error.code).toBe('AUTH_UNAVAILABLE');
    } finally {
      await h.sql(
        `drop trigger sso_fail_membership on app.memberships;
         drop function public.sso_fail_membership();`,
      );
    }
    expect(
      await one(
        `select (select count(*) from app.users where email_normalized = 'retry@${o.domain}')
             || ',' || (select count(*) from app.sso_identities where subject = 'sub-retry');`,
      ),
    ).toBe('1,1');
    expect(await membersOf(o)).toBe('1');
    expect((await signIn(w, who)).kind).toBe('signed_in');
    expect(await membersOf(o)).toBe('2');
    expect(
      await one(`select count(*) from app.users where email_normalized = 'retry@${o.domain}';`),
    ).toBe('1');
  });

  it('writes the user and the link in one transaction, so a failed link leaves no user', async () => {
    const w = world();
    const o = await organization({ jit: true });
    await h.sql(
      `create function public.sso_fail_link() returns trigger language plpgsql
         as $$ begin raise exception 'injected link failure'; end $$;
       create trigger sso_fail_link before insert on app.sso_identities
         for each row execute function public.sso_fail_link();`,
    );
    try {
      const failed = await w.sso.signInWithVerifiedIdentity(
        new Jar().context(),
        identity(o, `half@${o.domain}`),
        '/',
      );
      expect(failed.ok).toBe(false);
    } finally {
      await h.sql(
        `drop trigger sso_fail_link on app.sso_identities; drop function public.sso_fail_link();`,
      );
    }
    expect(
      await one(`select count(*) from app.users where email_normalized = 'half@${o.domain}';`),
    ).toBe('0');
  });

  it('accepts a pending invitation for the address', async () => {
    const w = world({ DREFYN_AUTH_SIGNUP: 'invite_only' });
    const o = await organization();
    await h.sql(
      `insert into app.invitations (organization_id, email_normalized, role, default_project_role,
           secret_hash, invited_by, expires_at)
         select '${o.organizationId}', 'invited@${o.domain}', 'admin', 'editor',
                decode(repeat('cd', 32), 'hex'), m.id, now() + interval '1 day'
           from app.memberships m where m.user_id = '${o.owner}';`,
    );
    expect((await signIn(w, identity(o, `invited@${o.domain}`))).kind).toBe('signed_in');
    expect(
      await one(
        `select m.role || ',' || m.default_project_role from app.memberships m
           join app.users u on u.id = m.user_id where u.email_normalized = 'invited@${o.domain}';
         select count(*) from app.invitations where organization_id = '${o.organizationId}';`,
      ),
    ).toBe('admin,editor\n0');
  });

  it('refuses with just in time off and no invitation, and keeps the person', async () => {
    const w = world();
    const o = await organization();
    expect(await signIn(w, identity(o, `nobody@${o.domain}`))).toEqual({
      kind: 'refused',
      reason: 'AUTH_SSO_NOT_PROVISIONED',
    });
    expect(await membersOf(o)).toBe('1');
  });

  it('lets a test connection sign in only its creator', async () => {
    const w = world();
    const o = await organization({ status: 'test', jit: true });
    await h.sql(
      `insert into app.sso_identities (organization_id, connection_id, user_id, subject, email_normalized)
         values ('${o.organizationId}', '${o.connectionId}', '${o.owner}', 'sub-maker', 'owner@${o.domain}');`,
    );
    expect((await signIn(w, identity(o, `owner@${o.domain}`, 'sub-maker'))).kind).toBe('signed_in');
    expect(await signIn(w, identity(o, `someone@${o.domain}`))).toEqual({
      kind: 'refused',
      reason: 'AUTH_SSO_NOT_PROVISIONED',
    });
    expect(
      await one(`select count(*) from app.users where email_normalized = 'someone@${o.domain}';`),
    ).toBe('0');
  });

  it('links an address match only after the code in the same browser', async () => {
    const w = world();
    const o = await organization();
    const person = await h.user(`linker@${o.domain}`);
    await h.sql(
      `insert into app.memberships (organization_id, user_id, role)
         values ('${o.organizationId}', '${person}', 'member');`,
    );
    const jar = new Jar();
    const done = await signIn(w, identity(o, `linker@${o.domain}`, 'sub-linker'), jar);
    if (done.kind !== 'link_code_sent') throw new Error(done.kind);
    await done.send();
    const sent = w.mail.sent.at(-1);
    if (sent === undefined) throw new Error('no code');
    const links = () => one(`select count(*) from app.sso_identities where user_id = '${person}';`);
    expect(await links()).toBe('0');

    const elsewhere = new Jar();
    const stolen = await w.email.verifyEmailCode(elsewhere.context(), {
      challenge: formatChallengeId(sent.challengeId),
      code: sent.code,
    });
    expect(stolen.ok ? 'ok' : stolen.error.code).toBe('AUTH_CHALLENGE_BINDING');
    expect(await links()).toBe('0');

    const verified = await w.email.verifyEmailCode(jar.context(), {
      challenge: formatChallengeId(sent.challengeId),
      code: sent.code,
    });
    expect(verified.ok ? 'ok' : verified.error.code).toBe('ok');
    expect(await links()).toBe('1');
    expect(
      await one(
        `select method || ',' || sso_connection_id from app.sessions where user_id = '${person}';`,
      ),
    ).toBe(`sso,${o.connectionId}`);
  });

  it('logs ids and outcomes only', async () => {
    const w = world();
    const o = await organization({ jit: true });
    await signIn(w, identity(o, `quiet@${o.domain}`, 'sub-quiet'));
    const logged = JSON.stringify(w.logs);
    for (const secret of [`quiet@${o.domain}`, 'sub-quiet', o.domain]) {
      expect(logged).not.toContain(secret);
    }
  });
});

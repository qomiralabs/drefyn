import { asSignedIn } from './support.ts';
import { randomUUID } from 'node:crypto';
import { idOf, organizationId, toPublicId, type UserId } from '@drefyn/tenancy';
import { describe, expect, it } from 'vitest';
import {
  createEmailSignIn,
  formatChallengeId,
  parseAuthConfig,
  type AuthConfig,
  type BrowserContext,
  type RateLimiter,
  type SessionInfo,
  type StartSessionInput,
} from '../src/index.ts';
import { createSsoSignIn, type FactorRule, type SsoCompleted } from '../src/sso-sign-in.ts';
import { createTestAuthMailer } from '../src/testing.ts';
import { mintVerifiedIdentity, type VerifiedIdentity } from '../src/verified-identity.ts';
import { Jar, logRecorder } from './oauth-fixtures.ts';
import { oauthStore } from './oauth-store.ts';
import { ssoStore, type Row, type SsoStoreFake } from './sso-store.ts';
import { validEnv } from './support.ts';

const ORG = organizationId('01a14984-4476-77ce-9335-12800000a001');
const CONN = idOf('ssc', '01a14984-4476-77ce-9335-12800000a002');
const SCOPE = { organizationId: ORG, connectionId: CONN };
const ADDRESS = 'ada@example.com';
const SUBJECT = 'idp-subject-0042';
const CREATOR_EMAIL = 'maker@example.com';

type SignUp = 'open' | 'invite_only' | 'closed';

const configFor = (signUp: SignUp): AuthConfig =>
  parseAuthConfig({ ...validEnv(), DREFYN_AUTH_SIGNUP: signUp });

const connection = (over: Row = {}): Row => ({
  id: CONN,
  status: 'active',
  jit_enabled: false,
  jit_default_project_role: null,
  display_name: 'Acme Okta',
  ...over,
});

const limiter: RateLimiter = {
  keyFor: () => Buffer.alloc(32),
  reserve: () => Promise.resolve(),
};

interface WorldOptions {
  readonly signUp?: SignUp;
  readonly connection?: Row | null;
  readonly fake?: SsoStoreFake;
  readonly factor?: FactorRule;
}

function world(options: WorldOptions = {}) {
  const config = configFor(options.signUp ?? 'open');
  const fake =
    options.fake ??
    ssoStore({
      connection: options.connection === undefined ? connection() : options.connection,
      domains: ['example.com'],
    });
  const started: StartSessionInput[] = [];
  // Sign ins the factor gate turned into a challenge, as startSession does for an enrolled
  // person.
  const gated: StartSessionInput[] = [];
  const sessions = {
    async startSession(_b: BrowserContext, input: StartSessionInput) {
      const enrolledNow =
        options.factor === undefined
          ? fake.tables.enrolled.has(input.userId)
          : await options.factor.required(input.userId);
      if (enrolledNow) {
        gated.push(input);
        return {
          kind: 'factor_required' as const,
          setCookies: [{ name: '__Host-drefyn_factor', value: 'c', maxAgeSeconds: 600 }],
        };
      }
      started.push(input);
      const user = fake.tables.users.find((u) => u['id'] === input.userId);
      const session: SessionInfo = {
        sessionId: idOf('ses', randomUUID()),
        userId: input.userId,
        email: typeof user?.['email'] === 'string' ? user['email'] : ADDRESS,
        authenticatedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
        method: input.method,
      };
      return {
        kind: 'session' as const,
        session,
        setCookies: [{ name: config.cookies.session, value: 'token', maxAgeSeconds: 60 }],
      };
    },
  };
  const { logs, logger } = logRecorder();
  const mail = createTestAuthMailer();
  const sso = createSsoSignIn(config, {
    store: fake.store,
    logger,
    mailer: mail.mailer,
    sessions,
    limiter,
    ...(options.factor === undefined ? {} : { factor: options.factor }),
  });
  return { config, fake, started, gated, logs, mail, sso };
}

type World = ReturnType<typeof world>;

function identity(
  over: Partial<Parameters<typeof mintVerifiedIdentity>[0]> = {},
): VerifiedIdentity {
  const minted = mintVerifiedIdentity({
    protocol: 'oidc',
    organizationId: ORG,
    connectionId: CONN,
    subject: SUBJECT,
    email: ADDRESS,
    displayName: 'Ada Lovelace',
    idpAuthenticatedAt: new Date(),
    ...over,
  });
  if (minted === null) throw new Error('identity fixture refused');
  return minted;
}

function addUser(w: World, email: string): UserId {
  const id = idOf('usr', randomUUID());
  w.fake.tables.users.push({ id, email, email_normalized: email });
  return id;
}

function link(w: World, userId: UserId, subject = SUBJECT): void {
  w.fake.tables.identities.push({
    organization_id: ORG,
    connection_id: CONN,
    user_id: userId,
    subject,
    email_normalized: ADDRESS,
  });
}

function member(w: World, userId: UserId, role = 'member'): void {
  w.fake.tables.memberships.push({ id: randomUUID(), organization_id: ORG, user_id: userId, role });
}

function invite(w: World, inviterRole: string | null = 'admin'): void {
  w.fake.tables.invitations.push({
    id: randomUUID(),
    organization_id: ORG,
    email_normalized: ADDRESS,
    role: 'member',
    default_project_role: 'editor',
    inviter_role: inviterRole,
  });
}

async function signIn(w: World, jar = new Jar(), who = identity()): Promise<SsoCompleted> {
  const result = await w.sso.signInWithVerifiedIdentity(jar.context(), who, '/acme/docs');
  if (!result.ok) throw result.error;
  return result.value;
}

const userIdOf = (w: World, email: string) =>
  w.fake.tables.users.find((u) => u['email_normalized'] === email)?.['id'];

const enrolled = (ids: () => readonly string[]): FactorRule => ({
  required: (userId) => Promise.resolve(ids().includes(userId)),
});

describe('signInWithVerifiedIdentity, the decision table', () => {
  it('signs a known subject in as that person, marking the link used', async () => {
    const w = world();
    const userId = addUser(w, 'renamed@example.com');
    link(w, userId);
    member(w, userId);
    const done = await signIn(w);
    expect(done).toMatchObject({ kind: 'signed_in', returnTo: '/acme/docs' });
    expect(w.started).toMatchObject([{ userId, method: 'sso', sso: SCOPE }]);
    expect(w.fake.tables.identities[0]?.['last_used_at']).toBeInstanceOf(Date);
    // Found by subject, never by the address the IdP sent this time.
    expect(w.fake.tables.users).toHaveLength(1);
  });

  it('sends a link code for an address match and links nothing', async () => {
    const w = world();
    const userId = addUser(w, ADDRESS);
    member(w, userId);
    const done = await signIn(w);
    expect(done.kind).toBe('link_code_sent');
    if (done.kind !== 'link_code_sent') return;
    await done.send();
    expect(w.mail.sent).toMatchObject([
      { to: ADDRESS, purpose: 'link_identity', linking: { provider: 'sso', account: 'Acme Okta' } },
    ]);
    expect(w.fake.tables.identities).toEqual([]);
    expect(w.started).toEqual([]);
    expect(w.fake.tables.email_challenges).toMatchObject([
      {
        user_id: userId,
        pending_provider: 'sso',
        pending_subject: SUBJECT,
        pending_sso_organization_id: ORG,
        pending_sso_connection_id: CONN,
      },
    ]);
  });

  it('sends the same link code for an address match with an enrolled factor', async () => {
    const w0 = world();
    const userId = addUser(w0, ADDRESS);
    const w = world({ fake: w0.fake, factor: enrolled(() => [userId]) });
    const done = await signIn(w);
    expect(done.kind).toBe('link_code_sent');
    expect(w.fake.tables.identities).toEqual([]);
  });

  describe('a new person', () => {
    it('is created with the link under open sign up, then needs a membership', async () => {
      const w = world({ signUp: 'open' });
      expect(await signIn(w)).toEqual({ kind: 'refused', reason: 'AUTH_SSO_NOT_PROVISIONED' });
      // A user without membership is valid: they can sign in and see no organization.
      expect(w.fake.tables.users).toMatchObject([
        { email_normalized: ADDRESS, display_name: 'Ada Lovelace' },
      ]);
      expect(w.fake.tables.identities).toMatchObject([
        { subject: SUBJECT, user_id: userIdOf(w, ADDRESS) },
      ]);
      expect(w.started).toEqual([]);
    });

    it('is created and joins under invite_only when just in time is on', async () => {
      const w = world({
        signUp: 'invite_only',
        connection: connection({ jit_enabled: true, jit_default_project_role: 'viewer' }),
      });
      const done = await signIn(w);
      expect(done.kind).toBe('signed_in');
      expect(w.fake.tables.memberships).toMatchObject([
        { user_id: userIdOf(w, ADDRESS), role: 'member', default_project_role: 'viewer' },
      ]);
      // An account made by this very sign in owes no new device notice.
      expect(done.kind === 'signed_in' && done.send).toBe(undefined);
    });

    it('is refused under invite_only with just in time off and no invitation', async () => {
      const w = world({ signUp: 'invite_only' });
      expect(await signIn(w)).toEqual({ kind: 'refused', reason: 'AUTH_SSO_NOT_PROVISIONED' });
      expect(w.fake.tables.users).toEqual([]);
    });

    it('is created under invite_only with just in time off when invited here', async () => {
      const w = world({ signUp: 'invite_only' });
      invite(w);
      const done = await signIn(w);
      expect(done.kind).toBe('signed_in');
      expect(w.fake.tables.memberships).toMatchObject([
        { role: 'member', default_project_role: 'editor' },
      ]);
      expect(w.fake.tables.invitations).toEqual([]);
    });

    it('is refused under closed sign up, whatever the connection allows', async () => {
      const w = world({ signUp: 'closed', connection: connection({ jit_enabled: true }) });
      invite(w);
      expect(await signIn(w)).toEqual({ kind: 'refused', reason: 'AUTH_SSO_SIGNUP_CLOSED' });
      expect(w.fake.tables.users).toEqual([]);
    });
  });

  describe('membership', () => {
    it('uses an existing membership and adds nothing', async () => {
      const w = world({ connection: connection({ jit_enabled: true }) });
      const userId = addUser(w, ADDRESS);
      link(w, userId);
      member(w, userId, 'admin');
      expect((await signIn(w)).kind).toBe('signed_in');
      expect(w.fake.tables.memberships).toHaveLength(1);
      expect(w.logs.map((l) => l.event)).not.toContain('auth.sso_provisioned');
    });

    it('accepts a pending invitation for the address with its role', async () => {
      const w = world();
      const userId = addUser(w, ADDRESS);
      link(w, userId);
      invite(w);
      expect((await signIn(w)).kind).toBe('signed_in');
      expect(w.fake.tables.memberships).toMatchObject([
        { user_id: userId, role: 'member', invitation_id: expect.any(String) as unknown },
      ]);
      expect(w.fake.tables.invitations).toEqual([]);
      expect(w.logs).toContainEqual(
        expect.objectContaining({
          event: 'auth.sso_provisioned',
          fields: expect.objectContaining({ via: 'invitation' }) as unknown,
        }),
      );
    });

    it('ignores an invitation whose inviter can no longer grant it', async () => {
      const w = world();
      const userId = addUser(w, ADDRESS);
      link(w, userId);
      invite(w, null);
      expect(await signIn(w)).toEqual({ kind: 'refused', reason: 'AUTH_SSO_NOT_PROVISIONED' });
      expect(w.fake.tables.memberships).toEqual([]);
    });

    it('adds a member just in time when a seat is free', async () => {
      const w = world({
        connection: connection({ jit_enabled: true, jit_default_project_role: 'editor' }),
      });
      w.fake.tables.tier = 'free';
      const userId = addUser(w, ADDRESS);
      link(w, userId);
      expect((await signIn(w)).kind).toBe('signed_in');
      expect(w.fake.tables.memberships).toMatchObject([
        { user_id: userId, role: 'member', default_project_role: 'editor' },
      ]);
      // Under the organization's row lock, acting as the person.
      const statements = w.fake.scripted.statements().map((s) => s.sql);
      const lock = statements.findIndex((s) => /from "organizations".*for update/.test(s));
      const insert = statements.findIndex((s) => s.startsWith('insert into "memberships"'));
      expect(lock).toBeGreaterThan(-1);
      expect(insert).toBeGreaterThan(lock);
      expect(w.fake.scripted.events).toContainEqual({
        kind: 'begin',
        scope: 'organization',
        organizationId: ORG,
        actorUserId: userId,
      });
    });

    it('refuses just in time at the seat limit and adds nobody', async () => {
      const w = world({ connection: connection({ jit_enabled: true }) });
      w.fake.tables.tier = 'free';
      // Free has five seats, all held.
      for (const n of [1, 2, 3, 4, 5]) member(w, addUser(w, `held${String(n)}@example.com`));
      const userId = addUser(w, ADDRESS);
      link(w, userId);
      expect(await signIn(w)).toEqual({ kind: 'refused', reason: 'AUTH_SSO_SEAT_LIMIT' });
      expect(w.fake.tables.memberships).toHaveLength(5);
      expect(w.started).toEqual([]);
    });

    it('refuses with just in time off and no invitation', async () => {
      const w = world();
      const userId = addUser(w, ADDRESS);
      link(w, userId);
      expect(await signIn(w)).toEqual({ kind: 'refused', reason: 'AUTH_SSO_NOT_PROVISIONED' });
      expect(w.started).toEqual([]);
    });
  });

  describe('a connection in test', () => {
    const testing = () => {
      const w = world({ connection: connection({ status: 'test', jit_enabled: true }) });
      const maker = addUser(w, CREATOR_EMAIL);
      member(w, maker, 'owner');
      w.fake.tables.creator = maker;
      return { w, maker };
    };

    it('signs its creator in', async () => {
      const { w, maker } = testing();
      link(w, maker);
      expect((await signIn(w)).kind).toBe('signed_in');
      expect(w.started).toMatchObject([{ userId: maker, method: 'sso', sso: SCOPE }]);
    });

    it('sends its creator a link code on the first sign in', async () => {
      const { w } = testing();
      const done = await signIn(w, new Jar(), identity({ email: CREATOR_EMAIL }));
      expect(done.kind).toBe('link_code_sent');
    });

    it('refuses someone else with a link, and never provisions them', async () => {
      const { w } = testing();
      const other = addUser(w, ADDRESS);
      link(w, other);
      expect(await signIn(w)).toEqual({ kind: 'refused', reason: 'AUTH_SSO_NOT_PROVISIONED' });
      expect(w.fake.tables.memberships).toHaveLength(1);
    });

    it('refuses someone else with an account and sends them nothing', async () => {
      const { w } = testing();
      addUser(w, ADDRESS);
      expect(await signIn(w)).toEqual({ kind: 'refused', reason: 'AUTH_SSO_NOT_PROVISIONED' });
      expect(w.mail.calls).toEqual([]);
    });

    it('never creates anyone', async () => {
      const { w } = testing();
      expect(await signIn(w)).toEqual({ kind: 'refused', reason: 'AUTH_SSO_NOT_PROVISIONED' });
      expect(w.fake.tables.users).toHaveLength(1);
    });

    it('never adds a member just in time, even for its creator without a membership', async () => {
      const { w, maker } = testing();
      w.fake.tables.memberships.splice(0);
      link(w, maker);
      expect(await signIn(w)).toEqual({ kind: 'refused', reason: 'AUTH_SSO_NOT_PROVISIONED' });
      expect(w.fake.tables.memberships).toEqual([]);
    });
  });
});

describe('signInWithVerifiedIdentity, the connection and the factor', () => {
  it.each(['draft', 'disabled', 'unknown'])(
    'refuses a %s connection before any lookup',
    async (status) => {
      const w = world({ connection: connection({ status }) });
      const result = await w.sso.signInWithVerifiedIdentity(new Jar().context(), identity(), '/');
      expect(result.ok ? null : result.error.code).toBe('AUTH_SSO_DISABLED');
      expect(w.fake.scripted.statements().some((s) => s.sql.includes('"users"'))).toBe(false);
    },
  );

  it('refuses a missing connection', async () => {
    const w = world({ connection: null });
    const result = await w.sso.signInWithVerifiedIdentity(new Jar().context(), identity(), '/');
    expect(result.ok ? null : result.error.code).toBe('AUTH_SSO_DISABLED');
  });

  it('refuses an address outside the verified domains', async () => {
    const w = world();
    const result = await w.sso.signInWithVerifiedIdentity(
      new Jar().context(),
      identity({ email: 'ada@elsewhere.example' }),
      '/',
    );
    expect(result.ok ? null : result.error.code).toBe('AUTH_SSO_EMAIL_OUTSIDE_DOMAIN');
  });

  it('gives an enrolled person factor_required and no session', async () => {
    const w0 = world();
    const userId = addUser(w0, ADDRESS);
    link(w0, userId);
    member(w0, userId);
    const w = world({ fake: w0.fake, factor: enrolled(() => [userId]) });
    expect(await signIn(w)).toEqual({
      kind: 'factor_required',
      setCookies: [{ name: '__Host-drefyn_factor', value: 'c', maxAgeSeconds: 600 }],
    });
    expect(w.started).toEqual([]);
  });

  it('leaves the factor to startSession and keeps the SSO scope for the challenge', async () => {
    const w = world();
    const userId = addUser(w, ADDRESS);
    link(w, userId);
    member(w, userId);
    w.fake.tables.enrolled.add(userId);
    expect(await signIn(w)).toMatchObject({ kind: 'factor_required' });
    expect(w.gated).toMatchObject([{ userId, method: 'sso', sso: SCOPE, returnTo: '/acme/docs' }]);
    expect(w.started).toEqual([]);
    expect(w.logs.map((l) => l.event)).toContain('auth.sso_factor_required');
  });

  it('owes a new device notice to a known person on a new browser', async () => {
    const w = world();
    const userId = addUser(w, ADDRESS);
    link(w, userId);
    member(w, userId);
    const done = await signIn(w);
    if (done.kind !== 'signed_in') throw new Error(done.kind);
    expect(done.setCookies.map((c) => c.name)).toContain(w.config.cookies.device);
    await done.send?.();
    expect(w.mail.notices).toMatchObject([
      { to: ADDRESS, notice: { kind: 'new_device_sign_in', method: 'sso' } },
    ]);
  });

  it('refuses an identity that was not minted, even when its shape is right', async () => {
    const w = world();
    const forged = { ...identity() } as VerifiedIdentity;
    const result = await w.sso.signInWithVerifiedIdentity(new Jar().context(), forged, '/');
    expect(result.ok ? null : result.error.code).toBe('AUTH_INPUT_INVALID');
    expect(w.fake.scripted.statements()).toEqual([]);
  });

  it('keeps a return path on the app origin only', async () => {
    const w = world({ connection: connection({ jit_enabled: true }) });
    const result = await w.sso.signInWithVerifiedIdentity(
      new Jar().context(),
      identity(),
      'https://evil.example/steal',
    );
    expect(result.ok && result.value.kind === 'signed_in' ? result.value.returnTo : null).toBe('/');
  });

  it('answers AUTH_UNAVAILABLE when the database fails, and logs ids only', async () => {
    const w = world();
    w.fake.failWhen('"sso_connections"');
    const result = await w.sso.signInWithVerifiedIdentity(new Jar().context(), identity(), '/');
    expect(result.ok ? null : result.error.code).toBe('AUTH_UNAVAILABLE');
    expect(w.logs).toContainEqual(
      expect.objectContaining({ level: 'warn', event: 'auth.sso_failed' }),
    );
  });
});

describe('partial failure and races', () => {
  it('leaves a user and link with no membership when the membership insert fails, and a retry completes it', async () => {
    const w = world({ connection: connection({ jit_enabled: true }) });
    w.fake.failWhen('insert into "memberships"');
    const first = await w.sso.signInWithVerifiedIdentity(new Jar().context(), identity(), '/');
    expect(first.ok ? null : first.error.code).toBe('AUTH_UNAVAILABLE');
    expect(w.fake.tables.users).toHaveLength(1);
    expect(w.fake.tables.identities).toHaveLength(1);
    expect(w.fake.tables.memberships).toEqual([]);
    w.fake.heal();
    expect((await signIn(w)).kind).toBe('signed_in');
    expect(w.fake.tables.users).toHaveLength(1);
    expect(w.fake.tables.memberships).toHaveLength(1);
  });

  it('treats an address signed up a moment ago as a link case', async () => {
    const w = world({ connection: connection({ jit_enabled: true }) });
    w.fake.beforeFirst('insert into "users"', () => {
      w.fake.tables.users.push({ id: randomUUID(), email: ADDRESS, email_normalized: ADDRESS });
    });
    expect((await signIn(w)).kind).toBe('link_code_sent');
    expect(w.fake.tables.identities).toEqual([]);
  });

  it('signs in through the link a parallel sign in made for the same subject', async () => {
    const w = world({ connection: connection({ jit_enabled: true }) });
    const winner = idOf('usr', randomUUID());
    w.fake.beforeFirst('insert into "sso_identities"', () => {
      w.fake.tables.users.push({
        id: winner,
        email: 'w@example.com',
        email_normalized: 'w@example.com',
      });
      link(w, winner);
    });
    expect((await signIn(w)).kind).toBe('signed_in');
    expect(w.started.map((s) => s.userId)).toEqual([winner]);
  });

  it('gives up after a second race instead of looping', async () => {
    const w = world({ connection: connection({ jit_enabled: true }) });
    // The subject is taken at every insert, yet never found by the lookup.
    link(w, idOf('usr', randomUUID()));
    w.fake.answerWhen('update "sso_identities"', []);
    // The fake keeps a rolled back user, which Postgres would not; the lookup ignores it.
    w.fake.answerWhen('select "id" from "users"', []);
    const result = await w.sso.signInWithVerifiedIdentity(new Jar().context(), identity(), '/');
    expect(result.ok ? null : result.error.code).toBe('AUTH_UNAVAILABLE');
  });
});

describe('failures on the way', () => {
  it('answers AUTH_UNAVAILABLE when creating the user fails, and writes no link', async () => {
    const w = world({ connection: connection({ jit_enabled: true }) });
    w.fake.failWhen('insert into "users"');
    const result = await w.sso.signInWithVerifiedIdentity(new Jar().context(), identity(), '/');
    expect(result.ok ? null : result.error.code).toBe('AUTH_UNAVAILABLE');
    expect(w.fake.tables.identities).toEqual([]);
  });

  it('answers AUTH_UNAVAILABLE when the link code cannot be stored, and links nothing', async () => {
    const w = world();
    addUser(w, ADDRESS);
    w.fake.failWhen('insert into "email_challenges"');
    const result = await w.sso.signInWithVerifiedIdentity(new Jar().context(), identity(), '/');
    expect(result.ok ? null : result.error.code).toBe('AUTH_UNAVAILABLE');
    expect(w.mail.calls).toEqual([]);
  });

  it('uses a membership a parallel sign in made while this one waited on the lock', async () => {
    const w = world({ connection: connection({ jit_enabled: true }) });
    w.fake.tables.tier = 'free';
    for (const n of [1, 2, 3, 4, 5]) member(w, addUser(w, `held${String(n)}@example.com`));
    const userId = addUser(w, ADDRESS);
    link(w, userId);
    w.fake.beforeFirst('for update', () => {
      member(w, userId);
    });
    // Already a member once the lock is held, so the full organization does not refuse.
    expect((await signIn(w)).kind).toBe('signed_in');
    expect(w.fake.tables.memberships).toHaveLength(6);
  });

  it('needs db and authDb, or a store, limiter and sessions', () => {
    const { logger } = logRecorder();
    expect(() =>
      createSsoSignIn(configFor('open'), { logger, mailer: createTestAuthMailer().mailer }),
    ).toThrow(TypeError);
  });
});

describe('the link by code', () => {
  // The SSO side and the code side, as the app joins them: the code is checked by email sign
  // in, which hands a proved SSO link to SSO sign in.
  async function linkWorld() {
    const base = world();
    const userId = addUser(base, ADDRESS);
    member(base, userId);
    const factorUsers: string[] = [];
    const w = world({ fake: base.fake, factor: enrolled(() => factorUsers) });
    const jar = new Jar();
    const done = await signIn(w, jar);
    if (done.kind !== 'link_code_sent') throw new Error(`expected a link code, got ${done.kind}`);
    jar.apply(done.setCookies);
    await done.send();
    const sent = w.mail.sent[0];
    if (sent === undefined) throw new Error('no code sent');
    const emailWith = (ssoLinks?: typeof w.sso) => {
      // The stored challenge, in the store email sign in reads.
      const codes = oauthStore();
      codes.tables.email_challenges.push(
        ...w.fake.tables.email_challenges.map((row) => ({
          ...row,
          live: true,
          consumed: false,
          attempts: 0,
        })),
      );
      return createEmailSignIn(w.config, {
        store: codes.store,
        logger: logRecorder().logger,
        mailer: w.mail.mailer,
        sessions: { startSession: () => Promise.reject(new Error('email must not start it')) },
        limiter,
        ...(ssoLinks === undefined ? {} : { ssoLinks }),
      });
    };
    return { w, userId, factorUsers, jar, sent, email: emailWith(w.sso), emailWith };
  }

  it('links only after the code, in the same browser, then signs in through SSO', async () => {
    const { w, userId, jar, sent, email } = await linkWorld();
    expect(w.fake.tables.identities).toEqual([]);
    const verified = await email.verifyEmailCode(jar.context(), {
      challenge: formatChallengeId(sent.challengeId),
      code: sent.code,
    });
    expect(verified.ok ? 'ok' : verified.error.code).toBe('ok');
    expect(w.fake.tables.identities).toMatchObject([
      { organization_id: ORG, connection_id: CONN, user_id: userId, subject: SUBJECT },
    ]);
    expect(w.started).toMatchObject([{ userId, method: 'sso', sso: SCOPE }]);
    if (verified.ok) await asSignedIn(verified.value).send?.();
    expect(w.mail.notices).toContainEqual({
      to: ADDRESS,
      notice: expect.objectContaining({
        kind: 'identity_linked',
        provider: 'sso',
        account: 'Acme Okta',
      }) as unknown,
    });
  });

  it('does not link when the code is redeemed in another browser', async () => {
    const { w, sent, email } = await linkWorld();
    const verified = await email.verifyEmailCode(new Jar().context(), {
      challenge: formatChallengeId(sent.challengeId),
      code: sent.code,
    });
    expect(verified.ok ? null : verified.error.code).toBe('AUTH_CHALLENGE_BINDING');
    const elsewhere = new Jar();
    elsewhere.cookies.set(w.config.cookies.pre, 'A'.repeat(43));
    const other = await email.verifyEmailCode(elsewhere.context(), {
      challenge: formatChallengeId(sent.challengeId),
      code: sent.code,
    });
    expect(other.ok ? null : other.error.code).toBe('AUTH_CHALLENGE_BINDING');
    expect(w.fake.tables.identities).toEqual([]);
    expect(w.started).toEqual([]);
  });

  it('does not link on a wrong code', async () => {
    const { w, jar, sent, email } = await linkWorld();
    const wrong = sent.code === '00000000' ? '00000001' : '00000000';
    const verified = await email.verifyEmailCode(jar.context(), {
      challenge: formatChallengeId(sent.challengeId),
      code: wrong,
    });
    expect(verified.ok ? null : verified.error.code).toBe('AUTH_CODE_INVALID');
    expect(w.fake.tables.identities).toEqual([]);
  });

  it('drops the link for an enrolled person and hands the code to a factor challenge', async () => {
    const { w, factorUsers, userId, jar, sent, email } = await linkWorld();
    factorUsers.push(userId);
    const verified = await email.verifyEmailCode(jar.context(), {
      challenge: formatChallengeId(sent.challengeId),
      code: sent.code,
    });
    expect(verified.ok && verified.value).toMatchObject({ kind: 'factor_required' });
    expect(w.fake.tables.identities).toEqual([]);
    // An email sign in, so the session carries no SSO scope the identity never earned.
    expect(w.gated).toEqual([{ userId, method: 'email', returnTo: '/acme/docs' }]);
    expect(w.started).toEqual([]);
  });

  it('reads a confirmed factor by default before it writes a link', async () => {
    const { w, userId, jar, sent } = await linkWorld();
    w.fake.tables.enrolled.add(userId);
    const sso = createSsoSignIn(w.config, {
      store: w.fake.store,
      logger: logRecorder().logger,
      mailer: w.mail.mailer,
      sessions: {
        startSession: () => Promise.resolve({ kind: 'factor_required', setCookies: [] }),
      },
      limiter,
    });
    const pending = w.fake.tables.email_challenges[0];
    if (pending === undefined) throw new Error('no challenge');
    const done = await sso.finishLink(jar.context(), {
      userId,
      email: ADDRESS,
      subject: SUBJECT,
      sso: SCOPE,
      returnTo: '/',
    });
    expect(done).toEqual({ ok: true, value: { kind: 'factor_required', setCookies: [] } });
    const read = w.fake.scripted.statements().find((s) => s.sql.includes('"totp_credentials"'));
    expect(read?.sql).toMatch(/"confirmed_at" is not null/);
    expect(w.fake.tables.identities).toEqual([]);
    expect(sent.code).toMatch(/^[0-9]{8}$/);
  });

  it('refuses an SSO link code when nothing can finish it', async () => {
    const { w, jar, sent, emailWith } = await linkWorld();
    const verified = await emailWith().verifyEmailCode(jar.context(), {
      challenge: formatChallengeId(sent.challengeId),
      code: sent.code,
    });
    expect(verified.ok ? null : verified.error.code).toBe('AUTH_CODE_INVALID');
    expect(w.fake.tables.identities).toEqual([]);
  });

  it('answers a subject linked meanwhile like a wrong code', async () => {
    const { w, jar, sent, email } = await linkWorld();
    w.fake.tables.identities.push({
      organization_id: ORG,
      connection_id: CONN,
      user_id: idOf('usr', randomUUID()),
      subject: SUBJECT,
    });
    const verified = await email.verifyEmailCode(jar.context(), {
      challenge: formatChallengeId(sent.challengeId),
      code: sent.code,
    });
    expect(verified.ok ? null : verified.error.code).toBe('AUTH_CODE_INVALID');
    expect(w.started).toEqual([]);
  });

  it('refuses the link when the connection was disabled after the code was sent', async () => {
    const { w, jar, sent, email } = await linkWorld();
    w.fake.tables.connection = connection({ status: 'disabled' });
    const verified = await email.verifyEmailCode(jar.context(), {
      challenge: formatChallengeId(sent.challengeId),
      code: sent.code,
    });
    expect(verified.ok ? null : verified.error.code).toBe('AUTH_SSO_DISABLED');
    expect(w.fake.tables.identities).toEqual([]);
  });

  it('refuses the link when the connection went to test and this is not its creator', async () => {
    const { w, jar, sent, email } = await linkWorld();
    w.fake.tables.connection = connection({ status: 'test' });
    const verified = await email.verifyEmailCode(jar.context(), {
      challenge: formatChallengeId(sent.challengeId),
      code: sent.code,
    });
    expect(verified.ok ? null : verified.error.code).toBe('AUTH_SSO_NOT_PROVISIONED');
    expect(w.fake.tables.identities).toEqual([]);
  });

  it('starts no session when the factor is enrolled between the link and the session', async () => {
    const { w, userId, factorUsers, jar, sent, email } = await linkWorld();
    w.fake.beforeFirst('insert into "sso_identities"', () => factorUsers.push(userId));
    const verified = await email.verifyEmailCode(jar.context(), {
      challenge: formatChallengeId(sent.challengeId),
      code: sent.code,
    });
    // Accepted: the link is written, but the gate still stops the session.
    expect(verified.ok && verified.value).toMatchObject({ kind: 'factor_required' });
    expect(w.fake.tables.identities).toHaveLength(1);
    expect(w.started).toEqual([]);
  });

  it('still signs in when the link notice cannot be sent', async () => {
    const { w, jar, sent, email } = await linkWorld();
    const verified = await email.verifyEmailCode(jar.context(), {
      challenge: formatChallengeId(sent.challengeId),
      code: sent.code,
    });
    if (!verified.ok) throw verified.error;
    w.mail.failNext();
    await asSignedIn(verified.value).send?.();
    expect(w.logs.map((l) => l.event)).toContain('auth.identity_notice_failed');
  });

  it('turns a membership refusal after the link into its code', async () => {
    const { w, jar, sent, email } = await linkWorld();
    w.fake.tables.memberships.splice(0);
    const verified = await email.verifyEmailCode(jar.context(), {
      challenge: formatChallengeId(sent.challengeId),
      code: sent.code,
    });
    expect(verified.ok ? null : verified.error.code).toBe('AUTH_SSO_NOT_PROVISIONED');
    // The link stays: the address proved itself, and the next sign in finds it by subject.
    expect(w.fake.tables.identities).toHaveLength(1);
  });
});

describe('redaction', () => {
  it('logs and stores no address, subject or code outside the rows that need them', async () => {
    const w = world({ connection: connection({ jit_enabled: true }) });
    const known = addUser(w, 'known@example.com');
    member(w, known);
    await signIn(w, new Jar(), identity({ email: 'known@example.com', subject: 'subject-known' }));
    await signIn(w);
    const logged = JSON.stringify(w.logs);
    for (const secret of [ADDRESS, 'known@example.com', SUBJECT, 'subject-known', 'example.com']) {
      expect(logged).not.toContain(secret);
    }
    for (const code of w.mail.calls.map((c) => c.code)) expect(logged).not.toContain(code);
    // Every event names the organization and the connection by public id.
    const sso = w.logs.filter((l) => l.event.startsWith('auth.sso_'));
    expect(sso.length).toBeGreaterThan(0);
    for (const line of sso) {
      expect(line.fields).toMatchObject({
        organizationId: toPublicId('org', ORG),
        connectionId: toPublicId('ssc', CONN),
      });
    }
  });

  it('puts no address or subject in an error', async () => {
    const w = world();
    w.fake.failWhen('"sso_identities"');
    const result = await w.sso.signInWithVerifiedIdentity(new Jar().context(), identity(), '/');
    expect(result.ok).toBe(false);
    const text = result.ok ? '' : `${result.error.message} ${JSON.stringify(result.error)}`;
    expect(text).not.toContain(ADDRESS);
    expect(text).not.toContain(SUBJECT);
  });
});

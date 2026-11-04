import type { AuthDatabase, Database } from '@drefyn/db';
import { idOf, toPublicId } from '@drefyn/tenancy';
import { describe, expect, it } from 'vitest';
import {
  ApiKeyReplayError,
  AuthError,
  createApiKeys,
  parseApiKey,
  type ApiKeysDeps,
  type CreateApiKeyInput,
  type ListApiKeysInput,
} from '../src/index.ts';
import { createTestAuthMailer } from '../src/testing.ts';
import {
  CREATED_AT,
  FIRST_REVOKED_AT,
  KEY,
  MEMBERSHIP,
  ORG,
  OTHER_KEY,
  OWNER_USER,
  PROJECT_A,
  PROJECT_B,
  REVOKED_AT,
  SCOPES,
  access,
  createResponder,
  isEmailsRead,
  isKeyInsert,
  isKeyProof,
  isCountsRead,
  isKeyProjects,
  isMemberRead,
  isOwnerRead,
  isPageRead,
  isProjectInsert,
  isRecentRead,
  isRevokeWrite,
  listResponder,
  listedRow,
  revokeResponder,
  sha,
  storedKey,
  type CreateShape,
  type ListShape,
  type RevokeShape,
} from './api-key-fixtures.ts';
import { scriptedStore, type Statement } from './scripted-store.ts';
import { SESSION, USER, capturingLogger } from './session-fixtures.ts';

const SECRET = Buffer.alloc(32, 3);

const INPUT: CreateApiKeyInput = {
  name: 'Deploy from CI',
  scopes: ['docs:read'],
  projectScope: 'all',
  idempotencyKey: 'create-1',
};

function setup(shape: CreateShape = {}, extra: Partial<ApiKeysDeps> = {}) {
  const scripted = scriptedStore(createResponder(shape));
  const { logger, lines } = capturingLogger();
  const mail = createTestAuthMailer();
  const keys = createApiKeys({
    store: scripted.store,
    scopes: SCOPES,
    logger,
    mailer: mail.mailer,
    random: (n) => SECRET.subarray(0, n),
    newKeyId: () => KEY,
    ...extra,
  });
  return { keys, scripted, lines, mail };
}

async function created(shape: CreateShape = {}, input: CreateApiKeyInput = INPUT) {
  const t = setup(shape);
  const result = await t.keys.createApiKey(access(), input);
  if (!result.ok) throw result.error;
  return { ...t, value: result.value };
}

async function refused(
  input: unknown,
  shape: CreateShape = {},
  a: ReturnType<typeof access> = access(),
) {
  const t = setup(shape);
  const result = await t.keys.createApiKey(a, input as CreateApiKeyInput);
  if (result.ok) throw new Error('expected a refusal');
  return { ...t, error: result.error };
}

const insertOf = (statements: readonly Statement[]) => {
  const found = statements.find(isKeyInsert);
  if (found === undefined) throw new Error('no key insert');
  return found;
};

describe('createApiKey', () => {
  it('returns the key once, as drf_ak_ with its organization, id and secret', async () => {
    const { value } = await created();
    const parts = parseApiKey(value.secret);
    expect(parts).toEqual({ organizationId: ORG, keyId: KEY, secret: SECRET });
    expect(value.key).toEqual({
      keyId: KEY,
      organizationId: ORG,
      name: 'Deploy from CI',
      displaySuffix: value.secret.slice(-4),
      scopes: ['docs:read'],
      projectScope: 'all',
      projectIds: [],
      createdBy: MEMBERSHIP,
      createdAt: CREATED_AT,
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    });
  });

  it('stores the hash and the last 4 characters, never the secret', async () => {
    const { value, scripted } = await created();
    const insert = insertOf(scripted.statements());
    expect(insert.parameters).toContainEqual(sha(SECRET));
    expect(insert.parameters).toContain(value.secret.slice(-4));
    const text = JSON.stringify(scripted.statements());
    expect(text).not.toContain(value.secret.slice('drf_ak_'.length + 54));
    for (const p of insert.parameters) {
      if (Buffer.isBuffer(p)) expect(p.equals(SECRET)).toBe(false);
    }
  });

  it('checks step up first, then the membership, then inserts in one organization transaction', async () => {
    const { scripted } = await created();
    expect(scripted.events[0]).toEqual({ kind: 'begin', scope: 'user', userId: USER });
    const statements = scripted.statements();
    expect(statements[0] !== undefined && isRecentRead(statements[0])).toBe(true);
    expect(statements[0]?.parameters).toContain(SESSION);
    expect(statements[1] !== undefined && isMemberRead(statements[1])).toBe(true);
    const orgBegins = scripted.events.filter(
      (e) => e.kind === 'begin' && e.scope === 'organization',
    );
    // The database binds created_by to this person, so the transaction must name them.
    expect(orgBegins).toEqual([
      { kind: 'begin', scope: 'organization', organizationId: ORG, actorUserId: USER },
    ]);
    expect(scripted.events.at(-1)).toEqual({ kind: 'commit' });
  });

  // A demotion or removal in flight waits for this read, so it then sees the new key and
  // revokes it; a plain read would let the key slip past.
  it('reads the creator membership for share', async () => {
    const { scripted } = await created();
    const member = scripted.statements().find(isMemberRead);
    expect(member?.sql).toMatch(/ for share$/);
  });

  it('writes listed projects and the listed scope', async () => {
    const { value, scripted } = await created(
      {},
      { ...INPUT, projectScope: 'listed', projectIds: [PROJECT_B, PROJECT_A, PROJECT_B] },
    );
    expect(value.key.projectScope).toBe('listed');
    expect(value.key.projectIds).toEqual([PROJECT_A, PROJECT_B].sort());
    expect(insertOf(scripted.statements()).parameters).toContain('listed');
    const projects = scripted.statements().find(isProjectInsert);
    expect(projects?.parameters).toEqual(expect.arrayContaining([PROJECT_A, PROJECT_B, KEY, ORG]));
  });

  it('refuses listed with no projects, so an empty list never means every project', async () => {
    for (const projectIds of [undefined, []]) {
      const { error, scripted } = await refused({ ...INPUT, projectScope: 'listed', projectIds });
      expect(error.code).toBe('AUTH_INPUT_INVALID');
      expect(scripted.statements()).toEqual([]);
    }
  });

  it('refuses all with a project list, since the two disagree', async () => {
    const { error } = await refused({ ...INPUT, projectScope: 'all', projectIds: [PROJECT_A] });
    expect(error.code).toBe('AUTH_INPUT_INVALID');
  });

  it('refuses a listed project the organization does not have', async () => {
    const { error, scripted } = await refused(
      { ...INPUT, projectScope: 'listed', projectIds: [PROJECT_A, PROJECT_B] },
      { projects: [PROJECT_A] },
    );
    expect(error.code).toBe('AUTH_INPUT_INVALID');
    expect(scripted.writes()).toEqual([]);
    expect(scripted.events.at(-1)).toEqual({ kind: 'rollback' });
  });

  it.each([
    ['no project scope', { ...INPUT, projectScope: undefined }],
    ['an unknown project scope', { ...INPUT, projectScope: 'some' }],
    ['an unknown scope', { ...INPUT, scopes: ['docs:write'] }],
    ['no scopes', { ...INPUT, scopes: [] }],
    ['33 scopes', { ...INPUT, scopes: Array.from({ length: 33 }, () => 'docs:read') }],
    ['an empty name', { ...INPUT, name: '   ' }],
    ['a name like a domain', { ...INPUT, name: 'see evil.example' }],
    ['a long name', { ...INPUT, name: 'a'.repeat(101) }],
    ['an empty idempotency key', { ...INPUT, idempotencyKey: '' }],
    ['a long idempotency key', { ...INPUT, idempotencyKey: 'a'.repeat(201) }],
    ['an idempotency key with a space', { ...INPUT, idempotencyKey: 'a b' }],
    ['an expiry in the past', { ...INPUT, expiresAt: new Date(Date.now() - 1000) }],
    ['an invalid date', { ...INPUT, expiresAt: new Date(Number.NaN) }],
    ['a project id that is not an id', { ...INPUT, projectScope: 'listed', projectIds: ['x'] }],
    [
      '101 projects',
      {
        ...INPUT,
        projectScope: 'listed',
        projectIds: Array.from(
          { length: 101 },
          (_, i) => `01890a5d-ac96-774b-bcce-${String(i).padStart(12, '0')}`,
        ),
      },
    ],
    ['an extra field', { ...INPUT, secret: 'mine' }],
    ['no input', undefined],
  ])('refuses %s with AUTH_INPUT_INVALID before any statement', async (_name, input) => {
    const { error, scripted } = await refused(input);
    expect(error.code).toBe('AUTH_INPUT_INVALID');
    expect(scripted.statements()).toEqual([]);
  });

  it('refuses a member without org.manage_api_keys before any statement', async () => {
    const { error, scripted } = await refused(INPUT, {}, access('member', 'editor'));
    expect(error.code).toBe('AUTH_FORBIDDEN');
    expect(scripted.statements()).toEqual([]);
  });

  it('refuses a scope whose permission the creator lacks', async () => {
    const t = setup();
    const a = { ...access('admin'), permissions: ['org.read', 'org.manage_api_keys', 'docs.read'] };
    const result = await t.keys.createApiKey(a as unknown as ReturnType<typeof access>, {
      ...INPUT,
      scopes: ['docs:read', 'status:read'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AUTH_FORBIDDEN');
    expect(t.scripted.statements()).toEqual([]);
  });

  it('checks the role again as stored now, so a demoted admin cannot create a key', async () => {
    const { error, scripted } = await refused(INPUT, { role: 'member' });
    expect(error.code).toBe('AUTH_FORBIDDEN');
    expect(scripted.writes()).toEqual([]);
  });

  it('refuses when the membership is gone', async () => {
    const { error, scripted } = await refused(INPUT, { role: null });
    expect(error.code).toBe('AUTH_FORBIDDEN');
    expect(scripted.writes()).toEqual([]);
  });

  it('answers AUTH_RECENT_AUTH_REQUIRED without a recent sign in, and writes nothing', async () => {
    const { error, scripted } = await refused(INPUT, { recent: false });
    expect(error.code).toBe('AUTH_RECENT_AUTH_REQUIRED');
    expect(scripted.statements()).toHaveLength(1);
    expect(scripted.writes()).toEqual([]);
  });

  it('answers AUTH_SESSION_INVALID when the session is gone', async () => {
    const { error } = await refused(INPUT, { sessionFound: false });
    expect(error.code).toBe('AUTH_SESSION_INVALID');
  });

  it('replays a repeated idempotency key with the summary and no secret', async () => {
    const hashOf = async () => {
      const first = await created();
      return insertOf(first.scripted.statements()).parameters.find(
        (p) => Buffer.isBuffer(p) && !p.equals(sha(SECRET)),
      );
    };
    const requestHash = await hashOf();
    const replay = {
      id: KEY,
      name: 'Deploy from CI',
      display_suffix: 'abcd',
      scopes: ['docs:read'],
      project_scope: 'all',
      created_by: MEMBERSHIP,
      created_at: CREATED_AT,
      expires_at: null,
      last_used_at: null,
      request_hash: requestHash,
    };
    const { error, mail } = await refused(INPUT, { inserted: false, replay });
    expect(error).toBeInstanceOf(ApiKeyReplayError);
    expect(error.code).toBe('AUTH_IDEMPOTENCY_REPLAY');
    const summary = (error as ApiKeyReplayError).existing;
    expect(summary).toMatchObject({ keyId: KEY, displaySuffix: 'abcd', projectScope: 'all' });
    expect(JSON.stringify(summary)).not.toContain('drf_ak_');
    expect(Object.keys(summary)).not.toContain('secret');
    expect(mail.notices).toEqual([]);
  });

  it('replays a listed key with its projects', async () => {
    const listed = { ...INPUT, projectScope: 'listed' as const, projectIds: [PROJECT_A] };
    const first = await created({}, listed);
    const requestHash = insertOf(first.scripted.statements()).parameters.filter((p) =>
      Buffer.isBuffer(p),
    )[1];
    const replay = {
      id: KEY,
      name: 'Deploy from CI',
      display_suffix: 'abcd',
      scopes: ['docs:read'],
      project_scope: 'listed',
      created_by: null,
      created_at: CREATED_AT,
      expires_at: null,
      last_used_at: null,
      request_hash: requestHash,
    };
    const { error } = await refused(listed, {
      inserted: false,
      replay,
      replayProjects: [PROJECT_A],
    });
    expect((error as ApiKeyReplayError).existing).toMatchObject({
      projectScope: 'listed',
      projectIds: [PROJECT_A],
      createdBy: null,
    });
  });

  it('shows a replay of a revoked key as revoked, so no caller takes it for a live one', async () => {
    const replay = {
      id: KEY,
      name: INPUT.name,
      display_suffix: 'abcd',
      scopes: ['docs:read'],
      project_scope: 'all',
      created_by: MEMBERSHIP,
      created_at: CREATED_AT,
      expires_at: null,
      last_used_at: null,
      revoked_at: REVOKED_AT,
    };
    const first = await created();
    const hash = insertOf(first.scripted.statements()).parameters.filter((p) =>
      Buffer.isBuffer(p),
    )[1];
    const { error } = await refused(INPUT, {
      inserted: false,
      replay: { ...replay, request_hash: hash },
    });
    expect(error).toBeInstanceOf(ApiKeyReplayError);
    expect((error as ApiKeyReplayError).existing.revokedAt).toEqual(REVOKED_AT);
  });

  it('refuses the same idempotency key with a different request', async () => {
    const replay = {
      id: KEY,
      name: 'Other',
      display_suffix: 'abcd',
      scopes: ['docs:read'],
      project_scope: 'all',
      created_by: MEMBERSHIP,
      created_at: CREATED_AT,
      expires_at: null,
      last_used_at: null,
      request_hash: Buffer.alloc(32, 1),
    };
    const { error, scripted } = await refused(INPUT, { inserted: false, replay });
    expect(error.code).toBe('AUTH_INPUT_INVALID');
    expect(error).not.toBeInstanceOf(ApiKeyReplayError);
    expect(scripted.events.at(-1)).toEqual({ kind: 'rollback' });
  });

  it('answers AUTH_UNAVAILABLE when the insert finds no row and no earlier key', async () => {
    const { error } = await refused(INPUT, { inserted: false, replay: null });
    expect(error.code).toBe('AUTH_UNAVAILABLE');
  });

  it('hashes the request the same whatever the order of scopes and projects', async () => {
    const hash = async (input: CreateApiKeyInput) => {
      const { scripted } = await created({}, input);
      return insertOf(scripted.statements()).parameters.filter((p) => Buffer.isBuffer(p))[1];
    };
    const listed = { ...INPUT, projectScope: 'listed' as const };
    const a = await hash({
      ...listed,
      scopes: ['docs:read', 'status:read'],
      projectIds: [PROJECT_A, PROJECT_B],
    });
    const b = await hash({
      ...listed,
      scopes: ['status:read', 'docs:read'],
      projectIds: [PROJECT_B, PROJECT_A],
    });
    const c = await hash({ ...listed, scopes: ['docs:read'], projectIds: [PROJECT_A, PROJECT_B] });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('sends a security notice to every owner after the response, never with the secret', async () => {
    const { value, mail, scripted } = await created({ owners: [OWNER_USER, USER] });
    expect(mail.notices).toEqual([]);
    await value.send();
    const read = scripted.statements().find(isEmailsRead);
    expect(read?.parameters).toEqual(expect.arrayContaining([OWNER_USER, USER]));
    expect(mail.notices).toHaveLength(1);
    expect(mail.notices[0]).toEqual({
      to: 'owner@example.com',
      notice: {
        kind: 'api_key_created',
        organizationId: ORG,
        keyId: KEY,
        keyName: 'Deploy from CI',
        displaySuffix: value.secret.slice(-4),
        at: CREATED_AT,
      },
    });
    expect(JSON.stringify(mail.notices)).not.toContain(value.secret);
  });

  it('send never throws when mail fails, and logs the failure by id', async () => {
    const { value, mail, lines } = await created();
    mail.failNext();
    await expect(value.send()).resolves.toBeUndefined();
    expect(lines.at(-1)).toEqual({
      event: 'auth.api_key_notice_failed',
      fields: { organizationId: toPublicId('org', ORG), keyId: toPublicId('key', KEY) },
    });
  });

  it('still tells the other owners when one send fails', async () => {
    const emails = ['one@example.com', 'two@example.com', 'three@example.com'];
    const { value, mail, lines } = await created({ emails });
    mail.failNext();
    await value.send();
    expect(mail.notices.map((n) => n.to)).toEqual(emails.slice(1));
    expect(lines.filter((l) => l.event === 'auth.api_key_notice_failed')).toHaveLength(1);
  });

  it('logs the creation by ids only, never the name or the secret', async () => {
    const { value, lines } = await created();
    expect(lines).toEqual([
      {
        event: 'auth.api_key_created',
        fields: {
          organizationId: toPublicId('org', ORG),
          keyId: toPublicId('key', KEY),
          membershipId: toPublicId('mem', MEMBERSHIP),
          userId: toPublicId('usr', USER),
          scopes: 1,
          projectScope: 'all',
        },
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain(value.secret.slice(-20));
    expect(JSON.stringify(lines)).not.toContain('Deploy');
  });

  it('answers AUTH_UNAVAILABLE and logs when the database fails', async () => {
    const t = setup();
    t.scripted.respondWith((s) => {
      if (isKeyInsert(s)) throw new Error('connection lost');
      return createResponder()(s);
    });
    const result = await t.keys.createApiKey(access(), INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AUTH_UNAVAILABLE');
    expect(t.lines.at(-1)?.event).toBe('auth.api_key_create_failed');
  });

  it('makes a fresh id and secret per call by default', async () => {
    const scripted = scriptedStore(createResponder());
    const { logger } = capturingLogger();
    const keys = createApiKeys({
      store: scripted.store,
      scopes: SCOPES,
      logger,
      mailer: createTestAuthMailer().mailer,
    });
    const one = await keys.createApiKey(access(), INPUT);
    const two = await keys.createApiKey(access(), { ...INPUT, idempotencyKey: 'create-2' });
    if (!one.ok || !two.ok) throw new Error('expected keys');
    expect(one.value.key.keyId).not.toBe(two.value.key.keyId);
    expect(one.value.secret).not.toBe(two.value.secret);
  });

  it('refuses to build without a store or both databases', () => {
    const { logger } = capturingLogger();
    const base = { scopes: SCOPES, logger, mailer: createTestAuthMailer().mailer };
    expect(() => createApiKeys(base)).toThrow(AuthError);
    expect(() => createApiKeys({ ...base, db: {} as Database })).toThrow(AuthError);
    expect(() =>
      createApiKeys({ ...base, db: {} as Database, authDb: {} as AuthDatabase }),
    ).not.toThrow();
  });
});

describe('revokeApiKey', () => {
  function revoker(shape: RevokeShape = {}) {
    const scripted = scriptedStore(revokeResponder(shape));
    const { logger, lines } = capturingLogger();
    const mail = createTestAuthMailer();
    const keys = createApiKeys({
      store: scripted.store,
      scopes: SCOPES,
      logger,
      mailer: mail.mailer,
    });
    return { keys, scripted, lines, mail };
  }

  async function revoked(shape: RevokeShape = {}) {
    const t = revoker(shape);
    const result = await t.keys.revokeApiKey(access(), KEY);
    if (!result.ok) throw result.error;
    return { ...t, value: result.value };
  }

  it('answers with the key, stamped by the database, and an unsent notice', async () => {
    const { value, mail } = await revoked();
    expect(value.alreadyRevoked).toBe(false);
    expect(value.key).toEqual({
      keyId: KEY,
      organizationId: ORG,
      name: 'Deploy from CI',
      displaySuffix: 'x7qa',
      scopes: ['docs:read'],
      projectScope: 'all',
      projectIds: [],
      createdBy: MEMBERSHIP,
      createdAt: CREATED_AT,
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: REVOKED_AT,
    });
    expect(mail.notices).toEqual([]);
  });

  it('checks step up, then the stored role, then writes, in one transaction naming the actor', async () => {
    const { scripted } = await revoked();
    const statements = scripted.statements();
    expect(statements[0] !== undefined && isRecentRead(statements[0])).toBe(true);
    expect(statements[1] !== undefined && isMemberRead(statements[1])).toBe(true);
    expect(statements[1]?.sql).toMatch(/for share$/);
    expect(statements[2] !== undefined && isRevokeWrite(statements[2])).toBe(true);
    expect(scripted.events.filter((e) => e.kind === 'begin' && e.scope === 'organization')).toEqual(
      [{ kind: 'begin', scope: 'organization', organizationId: ORG, actorUserId: USER }],
    );
    expect(scripted.events.at(-1)).toEqual({ kind: 'commit' });
  });

  it('writes only a live key of this organization, by database time', async () => {
    const { scripted } = await revoked();
    const write = scripted.statements().find(isRevokeWrite);
    expect(write?.sql).toContain('"revoked_at" = now()');
    expect(write?.sql).toContain('"revoked_at" is null');
    expect(write?.parameters).toEqual(expect.arrayContaining([ORG, KEY]));
  });

  it('never reads a hash or an idempotency key', async () => {
    const { scripted } = await revoked();
    const text = scripted
      .statements()
      .filter((s) => isRevokeWrite(s) || isKeyProof(s))
      .map((s) => s.sql)
      .join(' ');
    expect(text).not.toMatch(/secret_hash|request_hash|idempotency_key/);
  });

  it('reads the listed projects of a listed key', async () => {
    const t = revoker({ projectScope: 'listed', replayProjects: [PROJECT_A] });
    const result = await t.keys.revokeApiKey(access(), KEY);
    if (!result.ok) throw result.error;
    expect(result.value.key.projectIds).toEqual([PROJECT_A]);
  });

  it('reads no project rows for a key on every project', async () => {
    const { scripted } = await revoked();
    expect(scripted.statements().some(isKeyProjects)).toBe(false);
  });

  it.each(['not an id', '', 7, null, undefined])(
    'refuses %j as an id, before any statement',
    async (id) => {
      const t = revoker();
      const result = await t.keys.revokeApiKey(access(), id as never);
      expect(result.ok ? 'ok' : result.error.code).toBe('AUTH_INPUT_INVALID');
      expect(t.scripted.events).toEqual([]);
    },
  );

  it('refuses a member by the guard context, before any statement', async () => {
    const t = revoker();
    const result = await t.keys.revokeApiKey(access('member'), KEY);
    expect(result.ok ? 'ok' : result.error.code).toBe('AUTH_FORBIDDEN');
    expect(t.scripted.events).toEqual([]);
  });

  it('refuses a stale sign in before any organization work', async () => {
    const t = revoker({ recent: false });
    const result = await t.keys.revokeApiKey(access(), KEY);
    expect(result.ok ? 'ok' : result.error.code).toBe('AUTH_RECENT_AUTH_REQUIRED');
    expect(t.scripted.events.some((e) => e.kind === 'begin' && e.scope === 'organization')).toBe(
      false,
    );
  });

  it.each([
    ['demoted since the guard ran', 'member'],
    ['removed since the guard ran', null],
  ])('refuses someone %s, with no write', async (_name, role) => {
    const t = revoker({ role });
    const result = await t.keys.revokeApiKey(access(), KEY);
    expect(result.ok ? 'ok' : result.error.code).toBe('AUTH_FORBIDDEN');
    expect(t.scripted.statements().some(isRevokeWrite)).toBe(false);
    expect(t.scripted.events.at(-1)).toEqual({ kind: 'rollback' });
  });

  it('answers AUTH_NOT_FOUND for a key this organization cannot see, and tells nobody', async () => {
    const t = revoker({ state: 'absent' });
    const result = await t.keys.revokeApiKey(access(), OTHER_KEY);
    expect(result.ok ? 'ok' : result.error.code).toBe('AUTH_NOT_FOUND');
    expect(t.scripted.events.at(-1)).toEqual({ kind: 'rollback' });
    expect(t.lines).toEqual([]);
    expect(t.mail.notices).toEqual([]);
  });

  it('never calls a key revoked unless the row says so', async () => {
    const t = revoker();
    t.scripted.respondWith((s) => {
      if (isRevokeWrite(s)) return [];
      if (isKeyProof(s)) return [storedKey()];
      return revokeResponder()(s);
    });
    const result = await t.keys.revokeApiKey(access(), KEY);
    expect(result.ok ? 'ok' : result.error.code).toBe('AUTH_NOT_FOUND');
  });

  it('answers a second revoke with the first time, and sends and logs nothing', async () => {
    const { value, mail, lines, scripted } = await revoked({ state: 'revoked' });
    expect(value.alreadyRevoked).toBe(true);
    expect(value.key.revokedAt).toEqual(FIRST_REVOKED_AT);
    await value.send();
    expect(mail.notices).toEqual([]);
    expect(lines).toEqual([]);
    expect(scripted.statements().some(isOwnerRead)).toBe(false);
    expect(scripted.statements().some(isEmailsRead)).toBe(false);
  });

  it('holds the same step up and role checks on a key already revoked', async () => {
    const t = revoker({ state: 'revoked', recent: false });
    const result = await t.keys.revokeApiKey(access(), KEY);
    expect(result.ok ? 'ok' : result.error.code).toBe('AUTH_RECENT_AUTH_REQUIRED');
  });

  it('sends every owner the key, how it ends and when it was revoked, after the response', async () => {
    const emails = ['one@example.com', 'two@example.com'];
    const { value, mail } = await revoked({ emails });
    await value.send();
    expect(mail.notices).toEqual(
      emails.map((to) => ({
        to,
        notice: {
          kind: 'api_key_revoked',
          organizationId: ORG,
          keyId: KEY,
          keyName: 'Deploy from CI',
          displaySuffix: 'x7qa',
          at: REVOKED_AT,
        },
      })),
    );
  });

  it('still tells the other owners when one send fails, with one line per miss', async () => {
    const emails = ['one@example.com', 'two@example.com', 'three@example.com'];
    const { value, mail, lines } = await revoked({ emails });
    mail.failNext();
    await value.send();
    expect(mail.notices.map((n) => n.to)).toEqual(emails.slice(1));
    expect(lines.filter((l) => l.event === 'auth.api_key_notice_failed')).toEqual([
      {
        event: 'auth.api_key_notice_failed',
        fields: { organizationId: toPublicId('org', ORG), keyId: toPublicId('key', KEY) },
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain('@example.com');
  });

  it('send never throws when the addresses cannot be read, and logs by id', async () => {
    const t = await revoked();
    t.scripted.respondWith((s) => {
      if (isEmailsRead(s)) throw new Error('connection lost');
      return [];
    });
    await expect(t.value.send()).resolves.toBeUndefined();
    expect(t.lines.at(-1)?.event).toBe('auth.api_key_notice_failed');
  });

  it('has nobody to tell in an organization with no owner row', async () => {
    const { value, mail, scripted } = await revoked({ owners: [] });
    await value.send();
    expect(mail.notices).toEqual([]);
    expect(scripted.statements().some(isEmailsRead)).toBe(false);
  });

  it('logs the revoke by ids only, never the name', async () => {
    const { lines } = await revoked();
    expect(lines).toEqual([
      {
        event: 'auth.api_key_revoked',
        fields: {
          organizationId: toPublicId('org', ORG),
          keyId: toPublicId('key', KEY),
          membershipId: toPublicId('mem', MEMBERSHIP),
          userId: toPublicId('usr', USER),
        },
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain('Deploy');
  });

  it('answers AUTH_UNAVAILABLE and logs when the database fails, with the key still live', async () => {
    const t = revoker();
    t.scripted.respondWith((s) => {
      if (isRevokeWrite(s)) throw new Error('connection lost');
      return revokeResponder()(s);
    });
    const result = await t.keys.revokeApiKey(access(), KEY);
    expect(result.ok ? 'ok' : result.error.code).toBe('AUTH_UNAVAILABLE');
    expect(t.scripted.events.at(-1)).toEqual({ kind: 'rollback' });
    expect(t.lines.at(-1)).toEqual({
      event: 'auth.api_key_revoke_failed',
      fields: { organizationId: toPublicId('org', ORG), keyId: toPublicId('key', KEY) },
    });
  });
});

describe('listApiKeys', () => {
  function listSetup(shape: ListShape = {}) {
    const scripted = scriptedStore(listResponder(shape));
    const { logger, lines } = capturingLogger();
    const keys = createApiKeys({
      store: scripted.store,
      scopes: SCOPES,
      logger,
      mailer: createTestAuthMailer().mailer,
    });
    return { keys, scripted, lines };
  }

  async function listed(input: ListApiKeysInput = {}, shape: ListShape = {}) {
    const t = listSetup(shape);
    const result = await t.keys.listApiKeys(access(), input);
    if (!result.ok) throw result.error;
    return { ...t, page: result.value };
  }

  const ofKind = (statements: readonly Statement[], kind: (s: Statement) => boolean) => {
    const found = statements.find(kind);
    if (found === undefined) throw new Error('no such statement');
    return found;
  };

  const tooMany = Array.from({ length: 51 }, () => MEMBERSHIP);
  const cursorOf = (text: string) => Buffer.from(text).toString('base64url');

  it.each<[string, unknown]>([
    ['an empty search', { search: '' }],
    ['a search over 100 characters', { search: 'a'.repeat(101) }],
    ['a search that NFKC grows past 100', { search: '\uFDFA'.repeat(10) }],
    ['a search with a NUL', { search: 'a\u0000b' }],
    ['a search with half a surrogate pair', { search: 'a\uD800' }],
    ['a search of the wrong type', { search: 7 }],
    ['an unknown product', { products: ['billing'] }],
    ['an empty product list', { products: [] }],
    ['more products than exist', { products: ['docs', 'docs', 'docs', 'docs'] }],
    ['an empty creator list', { createdBy: [] }],
    ['a creator that is no id', { createdBy: ['nia'] }],
    ['a project id shaped creator of the wrong type', { createdBy: [7] }],
    ['51 creators', { createdBy: tooMany }],
    ['an unknown last used choice', { lastUsed: 'yesterday' }],
    ['a limit of 0', { limit: 0 }],
    ['a limit of 101', { limit: 101 }],
    ['a fractional limit', { limit: 1.5 }],
    ['a limit as text', { limit: '10' }],
    ['a cursor that is not ours', { cursor: 'abc' }],
    ['an empty cursor', { cursor: '' }],
    ['a cursor with no id', { cursor: cursorOf('k1.') }],
    ['a cursor of another version', { cursor: cursorOf(`k2.${KEY}`) }],
    ['a cursor with padding', { cursor: `${cursorOf(`k1.${KEY}`)}=` }],
    ['a cursor in upper case hex', { cursor: cursorOf(`k1.${KEY.toUpperCase()}`) }],
    ['a very long cursor', { cursor: 'a'.repeat(1_000) }],
    ['a field nobody asked for', { sort: 'name' }],
    ['no input at all', undefined],
  ])('refuses %s with no statement sent', async (_name, input) => {
    const t = listSetup();
    const result = await t.keys.listApiKeys(access(), input as ListApiKeysInput);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.code).toBe('AUTH_INPUT_INVALID');
    expect(t.scripted.statements()).toEqual([]);
  });

  it('refuses a context without org.read before any statement', async () => {
    const t = listSetup();
    const a = { ...access(), permissions: [] };
    const result = await t.keys.listApiKeys(a, {});
    expect(result.ok ? 'ok' : result.error.code).toBe('AUTH_FORBIDDEN');
    expect(t.scripted.statements()).toEqual([]);
  });

  it('lets a plain member read the list, with no step up', async () => {
    const t = listSetup();
    const result = await t.keys.listApiKeys(access('member'), {});
    expect(result.ok).toBe(true);
    expect(t.scripted.statements().some(isRecentRead)).toBe(false);
  });

  it('runs under the organization, on the read path with no actor', async () => {
    const t = await listed();
    expect(t.scripted.events[0]).toEqual({
      kind: 'begin',
      scope: 'organization',
      organizationId: ORG,
    });
  });

  it('sends three statements for a page with no listed key, and four with one', async () => {
    const none = await listed({}, { keys: [listedRow()] });
    expect(none.scripted.statements()).toHaveLength(3);
    const some = await listed({}, { keys: [listedRow({ project_scope: 'listed' })] });
    expect(some.scripted.statements()).toHaveLength(4);
  });

  it('names the organization in every statement', async () => {
    const t = await listed({}, { keys: [listedRow({ project_scope: 'listed' })] });
    for (const s of t.scripted.statements()) expect(s.parameters).toContain(ORG);
  });

  it('never names a hash or the idempotency key', async () => {
    const t = await listed({ search: 'a' }, { keys: [listedRow({ project_scope: 'listed' })] });
    const text = t.scripted
      .statements()
      .map((s) => s.sql)
      .join('\n');
    for (const column of ['secret_hash', 'request_hash', 'idempotency_key']) {
      expect(text).not.toContain(column);
    }
  });

  it('drops a hash from the result even if a row carried one', async () => {
    const row = listedRow({
      secret_hash: Buffer.alloc(32, 9),
      request_hash: Buffer.alloc(32, 8),
      idempotency_key: 'create-1',
    });
    const { page } = await listed({}, { keys: [row] });
    const item = page.items[0];
    expect(item).toBeDefined();
    expect(Object.keys(item ?? {}).sort()).toEqual(
      [
        'createdAt',
        'createdBy',
        'creatorName',
        'displaySuffix',
        'expiresAt',
        'keyId',
        'lastUsedAt',
        'name',
        'organizationId',
        'projectIds',
        'projectScope',
        'revokedAt',
        'scopes',
        'state',
      ].sort(),
    );
    expect(JSON.stringify(page)).not.toContain('create-1');
  });

  it('asks for one row past the limit, and offers no cursor when none comes back', async () => {
    const t = await listed({ limit: 2 }, { keys: [listedRow()] });
    expect(ofKind(t.scripted.statements(), isPageRead).parameters).toContain(3);
    expect(t.page.nextCursor).toBeNull();
  });

  it('defaults to 50 rows', async () => {
    const t = await listed();
    expect(ofKind(t.scripted.statements(), isPageRead).parameters).toContain(51);
  });

  it('accepts 1 and 100 as limits, 100 characters, and 50 creators', async () => {
    await expect(listed({ limit: 1 })).resolves.toBeDefined();
    await expect(listed({ limit: 100 })).resolves.toBeDefined();
    await expect(listed({ search: 'a'.repeat(100) })).resolves.toBeDefined();
    await expect(listed({ createdBy: tooMany.slice(1) })).resolves.toBeDefined();
  });

  it('cuts the extra row, and its cursor walks on from the last one shown', async () => {
    const rows = [listedRow({ id: OTHER_KEY }), listedRow({ id: KEY })];
    const first = await listed({ limit: 1 }, { keys: rows });
    expect(first.page.items.map((i) => i.keyId)).toEqual([OTHER_KEY]);
    expect(first.page.nextCursor).not.toBeNull();
    const cursor = first.page.nextCursor ?? '';
    expect(cursor).not.toContain(OTHER_KEY);
    const second = await listed({ limit: 1, cursor });
    expect(ofKind(second.scripted.statements(), isPageRead).sql).toContain('"k"."id" <');
    expect(ofKind(second.scripted.statements(), isPageRead).parameters).toContain(OTHER_KEY);
  });

  it('sends no cursor comparison on the first page', async () => {
    const t = await listed();
    expect(ofKind(t.scripted.statements(), isPageRead).sql).not.toContain('"k"."id" <');
  });

  it('normalizes the search with NFKC and binds it, so it never reaches the text', async () => {
    const t = await listed({ search: '\uFF21%' });
    const page = ofKind(t.scripted.statements(), isPageRead);
    expect(page.parameters).toContain('A%');
    expect(page.sql).toContain('strpos(lower(k.name), lower($');
    expect(page.sql).not.toContain('A%');
    expect(page.sql).not.toContain(' like ');
  });

  it('counts by the same filters as the page', async () => {
    const t = await listed({ search: 'deploy', products: ['docs'], lastUsed: 'never' });
    const counts = ofKind(t.scripted.statements(), isCountsRead);
    expect(counts.parameters).toContain('deploy');
    expect(counts.parameters).toContainEqual(['docs']);
    expect(counts.sql).toContain('k.last_used_at is null');
  });

  it('binds listed creators, and adds former only when asked', async () => {
    const both = await listed({ createdBy: [MEMBERSHIP, 'former'] });
    const page = ofKind(both.scripted.statements(), isPageRead);
    expect(page.parameters).toContainEqual([MEMBERSHIP]);
    expect(page.sql).toContain('k.created_by is null');
    const one = await listed({ createdBy: [MEMBERSHIP] });
    expect(ofKind(one.scripted.statements(), isPageRead).sql).not.toContain('k.created_by is null');
    const former = await listed({ createdBy: ['former'] });
    const onlyFormer = ofKind(former.scripted.statements(), isPageRead);
    expect(onlyFormer.sql).toContain('k.created_by is null');
    expect(onlyFormer.sql).not.toContain('= any');
  });

  it.each([
    ['7d', "interval '7 days'"],
    ['30d', "interval '30 days'"],
    ['never', 'k.last_used_at is null'],
  ] as const)('filters last used %s by database time', async (lastUsed, text) => {
    const t = await listed({ lastUsed });
    expect(ofKind(t.scripted.statements(), isPageRead).sql).toContain(text);
  });

  it('reads any as no last used filter at all', async () => {
    const t = await listed({ lastUsed: 'any' });
    expect(ofKind(t.scripted.statements(), isPageRead).sql).not.toContain('last_used_at >=');
    expect(ofKind(t.scripted.statements(), isPageRead).sql).not.toContain('last_used_at is');
  });

  it('shapes a page from its rows, with projects, states, names and counts', async () => {
    const creator = idOf('mem', MEMBERSHIP);
    const { page } = await listed(
      {},
      {
        keys: [
          listedRow({ id: OTHER_KEY, project_scope: 'listed', state: 'expired' }),
          listedRow({
            state: 'revoked',
            created_by: null,
            display_name: null,
            email: null,
            revoked_at: REVOKED_AT,
          }),
        ],
        projects: [
          { api_key_id: OTHER_KEY, target_project_id: PROJECT_A },
          { api_key_id: OTHER_KEY, target_project_id: PROJECT_B },
        ],
        counts: { total: 9, matched: 2, live: 4, former_keys: 3, docs: 7, studio: 1, status: 2 },
        creators: [{ id: creator, display_name: null, email: 'nia@example.com', keys: 6 }],
      },
    );
    expect(page.items[0]).toMatchObject({
      keyId: OTHER_KEY,
      state: 'expired',
      creatorName: 'Nia Reed',
      projectIds: [PROJECT_A, PROJECT_B],
    });
    expect(page.items[1]).toMatchObject({
      keyId: KEY,
      state: 'revoked',
      createdBy: null,
      creatorName: null,
      projectIds: [],
    });
    expect(page).toMatchObject({
      matched: 2,
      total: 9,
      live: 4,
      formerKeys: 3,
      products: { docs: 7, studio: 1, status: 2 },
      creators: [{ membershipId: creator, name: 'nia@example.com', keys: 6 }],
    });
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.items)).toBe(true);
    expect(Object.isFrozen(page.creators)).toBe(true);
  });

  it('uses the mail safe name, so a link shaped name never reaches the table', async () => {
    const { page } = await listed(
      {},
      {
        keys: [listedRow({ display_name: 'evil.example', email: 'a/b@evil.example' })],
        creators: [
          { id: MEMBERSHIP, display_name: 'www.evil.example', email: 'a/b@evil.example', keys: 1 },
        ],
      },
    );
    expect(page.items[0]?.creatorName).toBe('A team member');
    expect(page.creators[0]?.name).toBe('A team member');
  });

  it('fails closed on a stored state it does not know', async () => {
    const t = listSetup({ keys: [listedRow({ state: 'paused' })] });
    const result = await t.keys.listApiKeys(access(), {});
    expect(result.ok ? 'ok' : result.error.code).toBe('AUTH_UNAVAILABLE');
  });

  it('logs nothing on success', async () => {
    const t = await listed({ search: 'deploy' }, { keys: [listedRow()] });
    expect(t.lines).toEqual([]);
  });

  it('answers AUTH_UNAVAILABLE on a database failure, with ids and no search text', async () => {
    const scripted = scriptedStore(() => {
      throw new Error('connection lost near deploy-secret-name');
    });
    const { logger, lines } = capturingLogger();
    const keys = createApiKeys({
      store: scripted.store,
      scopes: SCOPES,
      logger,
      mailer: createTestAuthMailer().mailer,
    });
    const result = await keys.listApiKeys(access(), { search: 'deploy-secret-name' });
    expect(result.ok ? 'ok' : result.error.code).toBe('AUTH_UNAVAILABLE');
    expect(lines.map((l) => l.event)).toEqual(['auth.api_key_list_failed']);
    expect(JSON.stringify(lines)).not.toContain('deploy-secret-name');
  });
});

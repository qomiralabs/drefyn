import type { AuthDatabase, Database } from '@drefyn/db';
import { toPublicId } from '@drefyn/tenancy';
import { describe, expect, it } from 'vitest';
import {
  ApiKeyReplayError,
  AuthError,
  createApiKeys,
  parseApiKey,
  type ApiKeysDeps,
  type CreateApiKeyInput,
} from '../src/index.ts';
import { createTestAuthMailer } from '../src/testing.ts';
import {
  CREATED_AT,
  KEY,
  MEMBERSHIP,
  ORG,
  OWNER_USER,
  PROJECT_A,
  PROJECT_B,
  SCOPES,
  access,
  createResponder,
  isEmailsRead,
  isKeyInsert,
  isMemberRead,
  isProjectInsert,
  isRecentRead,
  sha,
  type CreateShape,
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

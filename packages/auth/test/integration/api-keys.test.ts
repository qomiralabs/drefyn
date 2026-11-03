import { createHash } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import {
  ApiKeyReplayError,
  apiKeyErrorResponse,
  parseApiKey,
  type CreatedApiKey,
} from '../../src/index.ts';
import { addProjects, input, memberOf, newOrg, testIp, type Org } from './support/api-keys.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';

const fresh = harness();
let h: Harness;

const bearer = (key: string) => `Bearer ${key}`;

async function create(org: Org, over: Parameters<typeof input>[0] = {}): Promise<CreatedApiKey> {
  const made = await h.apiKeys().createApiKey(org.owner, input(over));
  if (!made.ok) throw made.error;
  return made.value;
}

// The failure windows are a minute long by the database clock. A run of 61 that straddled a
// boundary would split across two windows, so it starts with at least 10 seconds left.
async function awayFromMinuteEdge(): Promise<void> {
  const left = Number(await h.sql(`select 60 - floor(extract(epoch from now()))::int % 60;`));
  if (left < 10) await new Promise((resolve) => setTimeout(resolve, (left + 1) * 1000));
}

describeWithStack('API keys against Postgres', () => {
  beforeAll(async () => {
    h = await fresh();
  });

  it('returns the secret once and stores only its hash and last 4 characters', async () => {
    const org = await newOrg(h);
    const made = await create(org);
    const parts = parseApiKey(made.secret);
    if (parts === null) throw new Error('not a key');
    expect(parts.organizationId).toBe(org.organizationId);
    const row = await h.sql(
      `select encode(secret_hash, 'hex') || '|' || display_suffix || '|' || project_scope
         from app.api_keys where id = '${parts.keyId}';`,
    );
    expect(row).toBe(
      `${createHash('sha256').update(parts.secret).digest('hex')}|${made.secret.slice(-4)}|all`,
    );
    // No column holds the secret in any form the person could paste back.
    const whole = await h.sql(
      `select row_to_json(k)::text from app.api_keys k where id = '${parts.keyId}';`,
    );
    expect(whole).not.toContain(made.secret.slice('drf_ak_'.length + 54, -4));
    expect(whole).not.toContain(parts.secret.toString('hex'));
    expect(made.key.displaySuffix).toBe(made.secret.slice(-4));
    expect(JSON.stringify(made.key)).not.toContain(made.secret);
  });

  it('verifies the key it returned, as an organization actor', async () => {
    const org = await newOrg(h);
    const made = await create(org, { scopes: ['docs:read', 'status:read'] });
    const result = await h.verifier().verifyApiKey(bearer(made.secret), testIp());
    if (!result.ok) throw result.error;
    expect(result.value).toEqual({
      kind: 'api_key',
      keyId: made.key.keyId,
      organizationId: org.organizationId,
      scopes: ['docs:read', 'status:read'],
      projectIds: 'all',
    });
  });

  it('writes last_used_at on first use and not again within the hour', async () => {
    const org = await newOrg(h);
    const made = await create(org);
    const used = () =>
      h.sql(
        `select coalesce(last_used_at::text, 'never') from app.api_keys where id = '${made.key.keyId}';`,
      );
    expect(await used()).toBe('never');
    const verifier = h.verifier();
    expect((await verifier.verifyApiKey(bearer(made.secret), testIp())).ok).toBe(true);
    const first = await used();
    expect(first).not.toBe('never');
    expect((await verifier.verifyApiKey(bearer(made.secret), testIp())).ok).toBe(true);
    expect(await used()).toBe(first);
  });

  it('reaches exactly the listed projects', async () => {
    const org = await newOrg(h);
    const projects = await addProjects(h, org.organizationId, 3);
    const listed = [projects[0], projects[2]].filter((p) => p !== undefined);
    const made = await create(org, { projectScope: 'listed', projectIds: listed });
    const result = await h.verifier().verifyApiKey(bearer(made.secret), testIp());
    if (!result.ok) throw result.error;
    expect(result.value.projectIds).toEqual([...listed].sort());
  });

  it('refuses listed with no projects and writes no key', async () => {
    const org = await newOrg(h);
    const result = await h
      .apiKeys()
      .createApiKey(org.owner, input({ projectScope: 'listed', projectIds: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AUTH_INPUT_INVALID');
    expect(
      await h.sql(
        `select count(*) from app.api_keys where organization_id = '${org.organizationId}';`,
      ),
    ).toBe('0');
  });

  it('refuses a listed project of another organization', async () => {
    const org = await newOrg(h);
    const other = await newOrg(h);
    const [theirs] = await addProjects(h, other.organizationId, 1);
    if (theirs === undefined) throw new Error('no project');
    const result = await h
      .apiKeys()
      .createApiKey(org.owner, input({ projectScope: 'listed', projectIds: [theirs] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AUTH_INPUT_INVALID');
  });

  it('replays a repeated idempotency key with AUTH_IDEMPOTENCY_REPLAY, the summary and no secret', async () => {
    const org = await newOrg(h);
    const request = input({ scopes: ['docs:read'] });
    const keys = h.apiKeys();
    const first = await keys.createApiKey(org.owner, request);
    if (!first.ok) throw first.error;
    const again = await keys.createApiKey(org.owner, request);
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.code).toBe('AUTH_IDEMPOTENCY_REPLAY');
    expect(again.error).toBeInstanceOf(ApiKeyReplayError);
    const summary = (again.error as ApiKeyReplayError).existing;
    expect(summary).toEqual(first.value.key);
    expect(JSON.stringify(again.error)).not.toContain(first.value.secret.slice(-20));
    expect(JSON.stringify(summary)).not.toContain(first.value.secret.slice(-20));
    expect(
      await h.sql(
        `select count(*) from app.api_keys where organization_id = '${org.organizationId}';`,
      ),
    ).toBe('1');
    // The same key for a different request changes nothing.
    const changed = await keys.createApiKey(org.owner, { ...request, name: 'Something else' });
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.error.code).toBe('AUTH_INPUT_INVALID');
  });

  it('refuses a member without org.manage_api_keys with AUTH_FORBIDDEN', async () => {
    const org = await newOrg(h);
    const { access } = await memberOf(h, org, 'member');
    const result = await h.apiKeys().createApiKey(access, input());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AUTH_FORBIDDEN');
  });

  it('refuses an admin demoted since the guard ran, by the role stored now', async () => {
    const org = await newOrg(h);
    const { access, session } = await memberOf(h, org, 'admin');
    await h.sql(`update app.memberships set role = 'member' where user_id = '${session.userId}';`);
    const result = await h.apiKeys().createApiKey(access, input());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AUTH_FORBIDDEN');
  });

  it('needs a sign in within 15 minutes', async () => {
    const org = await newOrg(h);
    await h.sql(
      `update app.sessions set authenticated_at = now() - interval '16 minutes' where id = '${org.ownerSessionId}';`,
    );
    const result = await h.apiKeys().createApiKey(org.owner, input());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AUTH_RECENT_AUTH_REQUIRED');
  });

  it('tells every owner about a new key, after the response', async () => {
    const org = await newOrg(h);
    const made = await create(org, { name: 'Release bot' });
    await made.send();
    const notices = h.mail.notices.filter(
      (n) => n.notice.kind === 'api_key_created' && n.notice.keyId === made.key.keyId,
    );
    expect(notices).toEqual([
      {
        to: org.ownerEmail,
        notice: {
          kind: 'api_key_created',
          organizationId: org.organizationId,
          keyId: made.key.keyId,
          keyName: 'Release bot',
          displaySuffix: made.secret.slice(-4),
          at: made.key.createdAt,
        },
      },
    ]);
  });

  it('refuses an expired key with one failure counted and no use written', async () => {
    const org = await newOrg(h);
    const made = await create(org);
    await h.sql(
      `update app.api_keys set created_at = now() - interval '2 days', expires_at = now() - interval '1 day'
        where id = '${made.key.keyId}';`,
    );
    const before = Number(await h.sql('select coalesce(sum(count), 0) from app.api_key_failures;'));
    const result = await h.verifier().verifyApiKey(bearer(made.secret), testIp());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AUTH_API_KEY_INVALID');
    expect(Number(await h.sql('select coalesce(sum(count), 0) from app.api_key_failures;'))).toBe(
      before + 1,
    );
    expect(
      await h.sql(
        `select coalesce(last_used_at::text, 'never') from app.api_keys where id = '${made.key.keyId}';`,
      ),
    ).toBe('never');
  });

  it('answers 429 with Retry-After on the 61st failure in a minute from one IP', async () => {
    const org = await newOrg(h);
    const made = await create(org);
    const wrong = `${made.secret.slice(0, -1)}${made.secret.endsWith('0') ? '1' : '0'}`;
    const verifier = h.verifier();
    const ip = testIp();
    await awayFromMinuteEdge();
    const codes: string[] = [];
    let last: unknown;
    for (let i = 0; i < 61; i += 1) {
      const result = await verifier.verifyApiKey(bearer(wrong), ip);
      if (result.ok) throw new Error('a wrong key verified');
      codes.push(result.error.code);
      last = result.error;
    }
    expect(codes.slice(0, 60).every((c) => c === 'AUTH_API_KEY_INVALID')).toBe(true);
    expect(codes[60]).toBe('AUTH_RATE_LIMITED');
    const response = apiKeyErrorResponse(last as Parameters<typeof apiKeyErrorResponse>[0]);
    expect(response.status).toBe(429);
    expect(Number(response.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(response.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect(JSON.parse(response.body)).toEqual({ error: { code: 'auth.rate_limited' } });
    // Counted in the global failure table.
    expect(
      Number(await h.sql('select max(count) from app.api_key_failures;')),
    ).toBeGreaterThanOrEqual(61);
    // Another address is not held to the first one's count.
    expect((await verifier.verifyApiKey(bearer(made.secret), testIp())).ok).toBe(true);
  });

  it('refuses a key in the query string, even beside a good header', async () => {
    const org = await newOrg(h);
    const made = await create(org);
    const result = await h.verifier().verifyApiRequest({
      authorization: bearer(made.secret),
      url: `https://api.drefyn.test/v1/docs?api_key=${made.secret}`,
      ip: testIp(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('AUTH_API_KEY_INVALID');
    expect(JSON.stringify(h.logs)).not.toContain(made.secret.slice(-20));
  });

  it('never logs a secret on any path in this file', () => {
    expect(JSON.stringify(h.logs).toLowerCase()).not.toContain('drf_ak_');
  });
});

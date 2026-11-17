import { verify } from 'node:crypto';
import { inspect } from 'node:util';
import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import {
  BROKER_ERROR_CODES,
  createGitHubBroker,
  GITHUB_FLAG,
  type BrokerDeps,
  type Installation,
  type MintRequest,
} from '../src/index.ts';
import { testKeys } from './support/keys.ts';
import { captureLogs } from './support/logs.ts';
import { fakeTransport, type Answer } from './support/transport.ts';

const keys = testKeys();

const tenant: TenantRef = {
  organizationId: organizationId('01a14984-4476-77ce-9335-620000000001'),
  projectId: projectId('01a14984-4476-77ce-9335-620000000002'),
};
const NOW = Date.parse('2026-11-17T10:00:00Z');
const TOKEN = 'ghs_fake_token_for_tests_only';
const INSTALLATION = 77;
const REPO = 4001;
const OTHER_REPO = 4002;

const installation: Installation = {
  tenant,
  installationId: INSTALLATION,
  accountId: 9,
  repositoryIds: [REPO, OTHER_REPO],
  suspended: false,
};

const granted = (overrides: Record<string, unknown> = {}): Answer => ({
  status: 201,
  json: {
    token: TOKEN,
    expires_at: '2026-11-17T11:00:00Z',
    permissions: { contents: 'read', metadata: 'read' },
    repository_selection: 'selected',
    repositories: [{ id: REPO, name: 'docs' }],
    ...overrides,
  },
});

const read: MintRequest = {
  tenant,
  installationId: INSTALLATION,
  repositoryId: REPO,
  permissions: { contents: 'read' },
  purpose: 'sync',
};

function setup(
  options: {
    flag?: boolean | Error;
    installation?: Installation | null | Error;
    deps?: Partial<BrokerDeps>;
  } = {},
) {
  const logs = captureLogs();
  const fake = fakeTransport();
  fake.answer(granted());
  const flagValue = options.flag ?? true;
  const flags = {
    isOn: vi.fn(() =>
      flagValue instanceof Error ? Promise.reject(flagValue) : Promise.resolve(flagValue),
    ),
  };
  const found = options.installation === undefined ? installation : options.installation;
  const installations = {
    get: vi.fn(() => (found instanceof Error ? Promise.reject(found) : Promise.resolve(found))),
  };
  const sleeps: number[] = [];
  const broker = createGitHubBroker({
    config: {
      appId: 4242,
      privateKeyFile: keys.privateKeyFile,
      apiUrl: 'https://api.github.com',
      allowPrivateCidrs: [],
      callTimeoutMs: 15_000,
    },
    installations,
    flags,
    logger: logs.logger,
    transport: fake.transport,
    clock: () => NOW,
    random: () => 0.5,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    ...options.deps,
  });
  return { broker, fake, logs, flags, installations, sleeps };
}

const decodeJwt = (header: string) => {
  const jwt = header.replace(/^Bearer /, '');
  const [h, p, s] = jwt.split('.');
  return {
    payload: JSON.parse(Buffer.from(p ?? '', 'base64url').toString()) as unknown,
    valid: verify(
      'RSA-SHA256',
      Buffer.from(`${h ?? ''}.${p ?? ''}`),
      keys.publicKey,
      Buffer.from(s ?? '', 'base64url'),
    ),
  };
};

describe('mintInstallationToken', () => {
  it('asks GitHub for one repository and the requested permission, signed by the App', async () => {
    const { broker, fake } = setup();
    const result = await broker.mintInstallationToken(read);
    expect(result.ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(
      `https://api.github.com/app/installations/${String(INSTALLATION)}/access_tokens`,
    );
    expect(JSON.parse(call?.body ?? '')).toEqual({
      repository_ids: [REPO],
      permissions: { contents: 'read' },
    });
    expect(call?.headers).toMatchObject({
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
    });
    const jwt = decodeJwt(call?.headers['authorization'] ?? '');
    expect(jwt.valid).toBe(true);
    expect(jwt.payload).toMatchObject({ iss: '4242' });
    expect(call?.policy).toMatchObject({
      purpose: 'github',
      allowPrivate: false,
      schemes: ['https'],
      ports: [443],
      maxRedirects: 0,
      totalTimeoutMs: 15_000,
      maxResponseBytes: 64 * 1024,
    });
  });

  it('hands back a token that only says what it can do', async () => {
    const { broker } = setup();
    const result = await broker.mintInstallationToken(read);
    if (!result.ok) throw new Error(result.error.code);
    const token = result.value;
    expect(token.repositoryId).toBe(REPO);
    expect(token.installationId).toBe(INSTALLATION);
    expect(token.permissions).toEqual({ contents: 'read' });
    expect(token.expiresAt.toISOString()).toBe('2026-11-17T11:00:00.000Z');
    expect(token.authorization(NOW)).toBe(`token ${TOKEN}`);
    const shown = [
      JSON.stringify(token),
      String(token),
      inspect(token, { showHidden: true, depth: 5 }),
      JSON.stringify(Object.entries(token)),
    ].join(' ');
    expect(shown).not.toContain(TOKEN);
  });

  it('refuses a token after it expires or is disposed', async () => {
    const { broker } = setup();
    const result = await broker.mintInstallationToken(read);
    if (!result.ok) throw new Error(result.error.code);
    expect(() => result.value.authorization(Date.parse('2026-11-17T11:00:00Z'))).toThrow(
      'github: token expired',
    );
    result.value.dispose();
    expect(result.value.disposed).toBe(true);
    expect(() => result.value.authorization(NOW)).toThrow('github: token disposed');
  });

  it('asks for write, and write with pull requests, only to commit', async () => {
    const { broker, fake } = setup();
    fake.answer(granted({ permissions: { contents: 'write', metadata: 'read' } }));
    const write = await broker.mintInstallationToken({
      ...read,
      purpose: 'commit',
      permissions: { contents: 'write' },
    });
    expect(write.ok).toBe(true);
    fake.answer(
      granted({ permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' } }),
    );
    const pr = await broker.mintInstallationToken({
      ...read,
      purpose: 'commit',
      permissions: { contents: 'write', pull_requests: 'write' },
    });
    expect(pr.ok).toBe(true);
    expect(JSON.parse(fake.calls[1]?.body ?? '')).toEqual({
      repository_ids: [REPO],
      permissions: { contents: 'write', pull_requests: 'write' },
    });
  });

  describe('narrowing', () => {
    it('refuses a repository the installation record does not hold, without calling GitHub', async () => {
      const { broker, fake, logs } = setup();
      const result = await broker.mintInstallationToken({ ...read, repositoryId: 999 });
      expect(result).toEqual({ ok: false, error: { code: 'github.repository_not_selected' } });
      expect(fake.calls).toEqual([]);
      expect(logs.lines.at(-1)).toMatchObject({
        level: 'warn',
        event: 'github.token_refused',
        fields: {
          organization_id: tenant.organizationId,
          project_id: tenant.projectId,
          installation_id: INSTALLATION,
          repository_id: 999,
          purpose: 'sync',
          code: 'github.repository_not_selected',
        },
      });
    });

    it.each([
      ['a second repository list', { repositoryIds: [REPO, OTHER_REPO] }],
      ['a repository list in place of one', { repositoryId: [REPO, OTHER_REPO] }],
      ['no repository', { repositoryId: undefined }],
      ['a repository id of zero', { repositoryId: 0 }],
      ['a fractional installation id', { installationId: 1.5 }],
      ['an unknown purpose', { purpose: 'admin' }],
      ['a tenant without a project', { tenant: { organizationId: tenant.organizationId } }],
    ])('refuses %s as an invalid request', async (_name, change) => {
      const { broker, fake, installations } = setup();
      const result = await broker.mintInstallationToken({ ...read, ...change } as MintRequest);
      expect(result).toEqual({ ok: false, error: { code: 'github.request_invalid' } });
      expect(fake.calls).toEqual([]);
      expect(installations.get).not.toHaveBeenCalled();
    });

    it.each([
      ['write to sync', 'sync', { contents: 'write' }],
      ['write to import', 'import', { contents: 'write' }],
      ['pull requests to sync', 'sync', { contents: 'write', pull_requests: 'write' }],
      ['read only to commit', 'commit', { contents: 'read' }],
      ['administration', 'sync', { contents: 'read', administration: 'write' }],
      ['workflows', 'commit', { contents: 'write', workflows: 'write' }],
      ['pull requests alone', 'commit', { pull_requests: 'write' }],
      ['pull requests read', 'commit', { contents: 'write', pull_requests: 'read' }],
      ['contents admin', 'sync', { contents: 'admin' }],
      ['no permission at all', 'sync', {}],
    ])('refuses %s as too wide', async (_name, purpose, permissions) => {
      const { broker, fake } = setup();
      const result = await broker.mintInstallationToken({
        ...read,
        purpose,
        permissions,
      } as unknown as MintRequest);
      expect(result).toEqual({ ok: false, error: { code: 'github.permission_too_wide' } });
      expect(fake.calls).toEqual([]);
    });

    it('never sends GitHub any permission set but the three allowed ones', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('import', 'sync', 'commit'),
          fc.dictionary(
            fc.constantFrom('contents', 'pull_requests', 'metadata', 'issues', 'administration'),
            fc.constantFrom('read', 'write', 'admin'),
          ),
          async (purpose, permissions) => {
            const { broker, fake } = setup();
            fake.answer({ status: 500 });
            await broker.mintInstallationToken({ ...read, purpose, permissions } as MintRequest);
            for (const call of fake.calls) {
              const sent = (JSON.parse(call.body) as { permissions: unknown }).permissions;
              expect([
                { contents: 'read' },
                { contents: 'write' },
                { contents: 'write', pull_requests: 'write' },
              ]).toContainEqual(sent);
              expect((JSON.parse(call.body) as { repository_ids: unknown }).repository_ids).toEqual(
                [REPO],
              );
            }
          },
        ),
        { numRuns: 200 },
      );
    });

    it.each([
      ['every repository', { repository_selection: 'all', repositories: undefined }],
      ['two repositories', { repositories: [{ id: REPO }, { id: OTHER_REPO }] }],
      ['another repository', { repositories: [{ id: OTHER_REPO }] }],
      ['no repository list', { repositories: undefined }],
      ['write when read was asked', { permissions: { contents: 'write', metadata: 'read' } }],
      ['an extra permission', { permissions: { contents: 'read', issues: 'write' } }],
      ['metadata write', { permissions: { contents: 'read', metadata: 'write' } }],
      ['less than was asked', { permissions: { metadata: 'read' } }],
    ])('revokes and refuses a token GitHub made wider: %s', async (_name, overrides) => {
      const { broker, fake, logs } = setup();
      fake.answer(granted(overrides), { status: 204 });
      const result = await broker.mintInstallationToken(read);
      expect(result).toEqual({ ok: false, error: { code: 'github.token_too_wide' } });
      expect(fake.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        `POST https://api.github.com/app/installations/${String(INSTALLATION)}/access_tokens`,
        'DELETE https://api.github.com/installation/token',
      ]);
      expect(fake.calls[1]?.headers['authorization']).toBe(`token ${TOKEN}`);
      expect(logs.text()).not.toContain(TOKEN);
      expect(logs.lines.map((l) => l.event)).toEqual(['github.token_refused']);
    });
  });

  describe('ownership and the flag', () => {
    it('refuses an installation not recorded for this project', async () => {
      const { broker, fake, installations } = setup({ installation: null });
      const result = await broker.mintInstallationToken(read);
      expect(result).toEqual({ ok: false, error: { code: 'github.installation_not_owned' } });
      expect(installations.get).toHaveBeenCalledWith(tenant, INSTALLATION);
      expect(fake.calls).toEqual([]);
    });

    it('refuses a suspended installation', async () => {
      const { broker, fake } = setup({ installation: { ...installation, suspended: true } });
      expect(await broker.mintInstallationToken(read)).toEqual({
        ok: false,
        error: { code: 'github.suspended' },
      });
      expect(fake.calls).toEqual([]);
    });

    it('answers unavailable when the record cannot be read', async () => {
      const { broker, logs } = setup({ installation: new Error('db down') });
      expect(await broker.mintInstallationToken(read)).toEqual({
        ok: false,
        error: { code: 'github.unavailable' },
      });
      expect(logs.text()).not.toContain('db down');
    });

    it('mints nothing and reads nothing with the flag off', async () => {
      const { broker, fake, installations, flags } = setup({ flag: false });
      expect(await broker.mintInstallationToken(read)).toEqual({
        ok: false,
        error: { code: 'github.disabled' },
      });
      expect(flags.isOn).toHaveBeenCalledWith(GITHUB_FLAG, {
        organizationId: tenant.organizationId,
        projectId: tenant.projectId,
      });
      expect(installations.get).not.toHaveBeenCalled();
      expect(fake.calls).toEqual([]);
    });

    it('fails closed when the flag cannot be read', async () => {
      const { broker, fake, logs } = setup({ flag: new Error('flagd down') });
      expect(await broker.mintInstallationToken(read)).toEqual({
        ok: false,
        error: { code: 'github.disabled' },
      });
      expect(fake.calls).toEqual([]);
      expect(logs.lines[0]).toMatchObject({
        level: 'warn',
        event: 'github.flag_read_failed',
        fields: { organization_id: tenant.organizationId, project_id: tenant.projectId },
      });
    });

    it('mints with the flag on', async () => {
      const { broker } = setup({ flag: true });
      expect((await broker.mintInstallationToken(read)).ok).toBe(true);
    });
  });

  describe('failures', () => {
    it.each([
      [404, {}, 'github.installation_not_owned'],
      [401, {}, 'github.unavailable'],
      [403, {}, 'github.suspended'],
      [
        403,
        { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1795385000' },
        'github.rate_limited',
      ],
      [429, { 'retry-after': '30' }, 'github.rate_limited'],
      [422, {}, 'github.repository_not_selected'],
      [418, {}, 'github.unavailable'],
    ] as const)('maps %i to its code without retrying', async (status, headers, code) => {
      const { broker, fake } = setup();
      fake.answer({ status, json: { message: 'nope' }, headers: { ...headers } });
      const result = await broker.mintInstallationToken(read);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(code);
      expect(fake.calls).toHaveLength(1);
    });

    it('says when to try again after a rate limit', async () => {
      const { broker, fake } = setup();
      fake.answer({ status: 429, headers: { 'retry-after': '30' } });
      expect(await broker.mintInstallationToken(read)).toEqual({
        ok: false,
        error: { code: 'github.rate_limited', retryAfterSeconds: 30 },
      });
      fake.answer({
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1000 + 90) },
      });
      expect(await broker.mintInstallationToken(read)).toEqual({
        ok: false,
        error: { code: 'github.rate_limited', retryAfterSeconds: 90 },
      });
      fake.answer({ status: 429, headers: { 'retry-after': 'soon' } });
      expect(await broker.mintInstallationToken(read)).toEqual({
        ok: false,
        error: { code: 'github.rate_limited' },
      });
    });

    it('retries a server error with jittered backoff, three tries at most', async () => {
      const { broker, fake, sleeps, logs } = setup();
      fake.answer({ status: 502 }, { status: 503 }, { status: 500 }, granted());
      expect(await broker.mintInstallationToken(read)).toEqual({
        ok: false,
        error: { code: 'github.unavailable' },
      });
      expect(fake.calls).toHaveLength(3);
      expect(sleeps).toEqual([100, 200]);
      expect(logs.lines.at(-1)?.fields).toMatchObject({
        code: 'github.unavailable',
        status: 500,
        attempts: 3,
      });
    });

    it('recovers when a retry succeeds', async () => {
      const { broker, fake } = setup();
      fake.answer({ error: 'egress.network_failed' }, granted());
      expect((await broker.mintInstallationToken(read)).ok).toBe(true);
      expect(fake.calls).toHaveLength(2);
    });

    it('never retries a refusal of the guard itself', async () => {
      const { broker, fake, logs } = setup();
      fake.answer({ error: 'egress.address_denied' });
      expect(await broker.mintInstallationToken(read)).toEqual({
        ok: false,
        error: { code: 'github.unavailable' },
      });
      expect(fake.calls).toHaveLength(1);
      expect(logs.lines.at(-1)?.fields).toMatchObject({ egress: 'egress.address_denied' });
    });

    it('stops when the caller aborts', async () => {
      const { broker, fake } = setup();
      fake.answer({ error: 'egress.aborted' });
      const controller = new AbortController();
      controller.abort();
      expect(await broker.mintInstallationToken(read, controller.signal)).toEqual({
        ok: false,
        error: { code: 'github.unavailable' },
      });
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]?.signal).toBe(controller.signal);
    });

    it.each([
      ['not JSON', { status: 201, raw: '{"token":' }],
      ['no token', granted({ token: '' })],
      ['a token with a space', granted({ token: 'ghs_a b' })],
      ['a bad expiry', granted({ expires_at: 'tomorrow' })],
      ['an expiry already past', granted({ expires_at: '2026-11-17T09:59:00Z' })],
      ['an expiry past the hour GitHub allows', granted({ expires_at: '2026-11-17T12:00:00Z' })],
      ['a 200 in place of 201', { status: 200, json: {} }],
    ] as const)('answers unavailable for a reply with %s', async (_name, answer) => {
      const { broker, fake, logs } = setup();
      fake.answer(answer);
      expect(await broker.mintInstallationToken(read)).toEqual({
        ok: false,
        error: { code: 'github.unavailable' },
      });
      expect(logs.text()).not.toContain('ghs_a b');
    });

    it('lists every code it can answer', () => {
      expect([...BROKER_ERROR_CODES].sort()).toEqual(
        [
          'github.disabled',
          'github.installation_not_owned',
          'github.permission_too_wide',
          'github.rate_limited',
          'github.repository_not_selected',
          'github.request_invalid',
          'github.suspended',
          'github.token_too_wide',
          'github.unavailable',
        ].sort(),
      );
    });
  });

  it('logs ids, codes and timings on every line, and never a token, a JWT or the key', async () => {
    const { broker, fake, logs } = setup();
    await broker.mintInstallationToken(read);
    fake.answer({ status: 404 });
    await broker.mintInstallationToken(read);
    const jwt = (fake.calls[0]?.headers['authorization'] ?? '').replace('Bearer ', '');
    for (const line of logs.lines) {
      expect(line.fields).toMatchObject({
        organization_id: tenant.organizationId,
        project_id: tenant.projectId,
      });
    }
    expect(logs.lines.map((l) => l.event)).toEqual(['github.token_minted', 'github.token_refused']);
    expect(logs.lines[0]?.fields).toEqual({
      organization_id: tenant.organizationId,
      project_id: tenant.projectId,
      installation_id: INSTALLATION,
      repository_id: REPO,
      purpose: 'sync',
      permissions: 'contents:read',
      attempts: 1,
      duration_ms: 0,
    });
    const text = logs.text();
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(jwt.split('.')[2] ?? 'unreachable');
    expect(text).not.toContain('PRIVATE KEY');
  });
});

describe('withInstallationToken', () => {
  it('lends the token to the job, then revokes and forgets it', async () => {
    const { broker, fake } = setup();
    fake.answer(granted(), { status: 204 });
    let seen: string | null = null;
    let kept: { authorization(now?: number): string } | null = null;
    const result = await broker.withInstallationToken(read, (token) => {
      seen = token.authorization(NOW);
      kept = token;
      return Promise.resolve('done');
    });
    expect(result).toEqual({ ok: true, value: 'done' });
    expect(seen).toBe(`token ${TOKEN}`);
    expect(() => kept?.authorization(NOW)).toThrow('github: token disposed');
    expect(fake.calls.map((c) => c.method)).toEqual(['POST', 'DELETE']);
    expect(fake.calls[1]?.headers['authorization']).toBe(`token ${TOKEN}`);
  });

  it('revokes when the job throws, and throws on', async () => {
    const { broker, fake } = setup();
    fake.answer(granted(), { status: 204 });
    await expect(
      broker.withInstallationToken(read, () => Promise.reject(new Error('job failed'))),
    ).rejects.toThrow('job failed');
    expect(fake.calls.map((c) => c.method)).toEqual(['POST', 'DELETE']);
  });

  it('runs nothing when no token can be had', async () => {
    const { broker } = setup({ flag: false });
    const work = vi.fn(() => Promise.resolve(1));
    expect(await broker.withInstallationToken(read, work)).toEqual({
      ok: false,
      error: { code: 'github.disabled' },
    });
    expect(work).not.toHaveBeenCalled();
  });

  it('keeps the result when the revoke fails, and logs that it did', async () => {
    const { broker, fake, logs } = setup();
    fake.answer(granted(), { status: 500 });
    expect(await broker.withInstallationToken(read, () => Promise.resolve(2))).toEqual({
      ok: true,
      value: 2,
    });
    expect(logs.lines.at(-1)).toMatchObject({
      level: 'warn',
      event: 'github.token_revoke_failed',
      fields: { organization_id: tenant.organizationId, status: 500 },
    });
    expect(logs.text()).not.toContain(TOKEN);
  });
});

describe('createGitHubBroker', () => {
  it('refuses to start without a readable App key', () => {
    expect(() =>
      setup({
        deps: {
          config: {
            appId: 1,
            privateKeyFile: `${keys.dir}/absent.pem`,
            apiUrl: 'https://api.github.com',
            allowPrivateCidrs: [],
            callTimeoutMs: 15_000,
          },
        },
      }),
    ).toThrow('DREFYN_GITHUB_PRIVATE_KEY_FILE');
  });

  it('keeps the path prefix of an Enterprise Server API and its port in the policy', async () => {
    const { broker, fake } = setup({
      deps: {
        config: {
          appId: 1,
          privateKeyFile: keys.privateKeyFile,
          apiUrl: 'https://ghe.example.com:8443/api/v3',
          allowPrivateCidrs: ['10.20.0.0/16'],
          callTimeoutMs: 5000,
        },
      },
    });
    await broker.mintInstallationToken(read);
    expect(fake.calls[0]?.url).toBe(
      `https://ghe.example.com:8443/api/v3/app/installations/${String(INSTALLATION)}/access_tokens`,
    );
    expect(fake.calls[0]?.policy).toMatchObject({
      ports: [8443],
      allowPrivate: { cidrs: ['10.20.0.0/16'] },
      totalTimeoutMs: 5000,
    });
  });
});

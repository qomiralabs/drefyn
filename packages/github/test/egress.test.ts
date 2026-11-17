import { verify } from 'node:crypto';
import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGitHubBroker, type GitHubAppConfig, type MintRequest } from '../src/index.ts';
import { startFakeGitHub, type FakeGitHub } from './support/fake-github.ts';
import { testKeys } from './support/keys.ts';
import { captureLogs } from './support/logs.ts';

// No transport is passed here: the broker sends through the egress guard as it does in
// production, and the guard dials a fake GitHub on loopback over TLS.

const keys = testKeys();
const tenant: TenantRef = {
  organizationId: organizationId('01a14984-4476-77ce-9335-620000000011'),
  projectId: projectId('01a14984-4476-77ce-9335-620000000012'),
};
const request: MintRequest = {
  tenant,
  installationId: 77,
  repositoryId: 4001,
  permissions: { contents: 'read' },
  purpose: 'sync',
};

let github: FakeGitHub;
beforeAll(async () => {
  github = await startFakeGitHub();
});
afterAll(async () => {
  await github.close();
});

function broker(config: Partial<GitHubAppConfig>) {
  const logs = captureLogs();
  const made = createGitHubBroker({
    config: {
      appId: 4242,
      privateKeyFile: keys.privateKeyFile,
      apiUrl: github.apiUrl,
      allowPrivateCidrs: [],
      callTimeoutMs: 5000,
      ...config,
    },
    installations: {
      get: () =>
        Promise.resolve({
          tenant,
          installationId: 77,
          accountId: 9,
          repositoryIds: [4001],
          suspended: false,
        }),
    },
    flags: { isOn: () => Promise.resolve(true) },
    logger: logs.logger,
    sleep: () => Promise.resolve(),
  });
  return { made, logs };
}

describe('the broker through the egress guard', () => {
  it('reaches GitHub only through the guard, which refuses a private address by default', async () => {
    github.requests.length = 0;
    const { made, logs } = broker({});
    expect(await made.mintInstallationToken(request)).toEqual({
      ok: false,
      error: { code: 'github.unavailable' },
    });
    expect(github.requests).toEqual([]);
    expect(logs.lines.at(-1)?.fields).toMatchObject({ egress: 'egress.address_denied' });
  });

  it('mints a narrowed token from an API on a range the operator allowed', async () => {
    github.requests.length = 0;
    github.handle((req) => {
      if (req.method === 'DELETE') return { status: 204 };
      const [h, p, s] = req.authorization.replace('Bearer ', '').split('.');
      const signed = verify(
        'RSA-SHA256',
        Buffer.from(`${h ?? ''}.${p ?? ''}`),
        keys.publicKey,
        Buffer.from(s ?? '', 'base64url'),
      );
      if (!signed) return { status: 401, body: { message: 'Bad credentials' } };
      const asked = JSON.parse(req.body) as {
        repository_ids: number[];
        permissions: Record<string, string>;
      };
      return {
        status: 201,
        body: {
          token: 'ghs_fake_token_from_loopback',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          permissions: { ...asked.permissions, metadata: 'read' },
          repository_selection: 'selected',
          repositories: asked.repository_ids.map((id) => ({ id })),
        },
      };
    });
    const { made } = broker({ allowPrivateCidrs: ['127.0.0.1/32'] });
    const result = await made.withInstallationToken(request, (token) =>
      Promise.resolve(token.authorization()),
    );
    expect(result).toEqual({ ok: true, value: 'token ghs_fake_token_from_loopback' });
    expect(github.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'POST /app/installations/77/access_tokens',
      'DELETE /installation/token',
    ]);
    expect(JSON.parse(github.requests[0]?.body ?? '')).toEqual({
      repository_ids: [4001],
      permissions: { contents: 'read' },
    });
  });

  it('answers unavailable when GitHub does not take the App key', async () => {
    github.handle(() => ({ status: 401, body: { message: 'Bad credentials' } }));
    const { made } = broker({ allowPrivateCidrs: ['127.0.0.1/32'] });
    expect(await made.mintInstallationToken(request)).toEqual({
      ok: false,
      error: { code: 'github.unavailable' },
    });
  });
});

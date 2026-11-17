import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWebhookReceiver,
  type DeliveryClaim,
  type DeliveryLedger,
  type VerifiedDelivery,
} from '@drefyn/github';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { mountGitHubWebhook } from '../src/github-webhook.ts';
import { fakeDeps, socketEnv } from './support.ts';

const secret = new TextEncoder().encode('a-webhook-secret-for-api-tests');
const body = JSON.stringify({
  installation: { id: 77 },
  repository: { id: 4001 },
  ref: 'refs/heads/main',
});
const sign = (text: string) => `sha256=${createHmac('sha256', secret).update(text).digest('hex')}`;

function ledger(): DeliveryLedger {
  const seen = new Set<string>();
  return {
    claim: (claim: DeliveryClaim) => {
      if (seen.has(claim.deliveryId)) return Promise.resolve('replayed');
      seen.add(claim.deliveryId);
      return Promise.resolve('new');
    },
    release: (deliveryId) => {
      seen.delete(deliveryId);
      return Promise.resolve();
    },
  };
}

function app(maxBodyBytes = 1024 * 1024) {
  const { deps, logs } = fakeDeps({ config: { hops: 0, viewerHeader: false, maxBodyBytes } });
  const delivered: VerifiedDelivery[] = [];
  const made = createApp(deps);
  mountGitHubWebhook(
    made,
    createWebhookReceiver({
      secret,
      ledger: ledger(),
      logger: deps.logger,
      onDelivery: (delivery) => {
        delivered.push(delivery);
        return Promise.resolve();
      },
    }),
  );
  return { app: made, logs, delivered };
}

const post = (
  target: ReturnType<typeof app>['app'],
  headers: Record<string, string>,
  text = body,
) =>
  target.request(
    '/webhooks/github',
    { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: text },
    socketEnv(),
  );

describe('POST /webhooks/github', () => {
  it('accepts a signed delivery with no API key and hands it on', async () => {
    const { app: target, delivered, logs } = app();
    const deliveryId = randomUUID();
    const response = await post(target, {
      'x-hub-signature-256': sign(body),
      'x-github-delivery': deliveryId,
      'x-github-event': 'push',
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: 'accepted' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(delivered.map((d) => [d.deliveryId, d.installationId, d.repositoryId])).toEqual([
      [deliveryId, 77, 4001],
    ]);
    expect(logs.map((l) => l.event)).toEqual(['github.webhook_accepted', 'api.request']);
    expect(logs.at(-1)?.fields).toMatchObject({ route: '/webhooks/github', status: 202 });
  });

  it.each([
    ['no signature', {}, 401, 'github.signature_invalid'],
    ['a bad signature', { 'x-hub-signature-256': sign('other') }, 401, 'github.signature_invalid'],
  ])('refuses %s with the common error body', async (_name, headers, status, code) => {
    const { app: target, delivered, logs } = app();
    const response = await post(target, {
      'x-github-delivery': randomUUID(),
      'x-github-event': 'push',
      ...headers,
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      error: { code, message: 'The webhook signature is missing or not valid.' },
    });
    expect(delivered).toEqual([]);
    expect(JSON.stringify(logs)).not.toContain('refs/heads/main');
  });

  it('refuses a replay of the same delivery', async () => {
    const { app: target, delivered } = app();
    const headers = {
      'x-hub-signature-256': sign(body),
      'x-github-delivery': randomUUID(),
      'x-github-event': 'push',
    };
    expect((await post(target, headers)).status).toBe(202);
    const again = await post(target, headers);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe(
      'github.delivery_replayed',
    );
    expect(delivered).toHaveLength(1);
  });

  it('refuses a malformed delivery id and a body that is not JSON', async () => {
    const { app: target } = app();
    const bad = await post(target, {
      'x-hub-signature-256': sign(body),
      'x-github-delivery': 'not-a-guid',
      'x-github-event': 'push',
    });
    expect(bad.status).toBe(400);
    const text = 'not json';
    const junk = await post(
      target,
      {
        'x-hub-signature-256': sign(text),
        'x-github-delivery': randomUUID(),
        'x-github-event': 'push',
      },
      text,
    );
    expect(junk.status).toBe(400);
    expect(((await junk.json()) as { error: { code: string } }).error.code).toBe(
      'github.payload_invalid',
    );
  });

  it('keeps the service body limit in front of the check', async () => {
    const { app: target, delivered } = app(16);
    const response = await post(target, {
      'x-hub-signature-256': sign(body),
      'x-github-delivery': randomUUID(),
      'x-github-event': 'push',
    });
    expect(response.status).toBe(413);
    expect(delivered).toEqual([]);
  });

  it('answers only POST', async () => {
    const { app: target } = app();
    const response = await target.request('/webhooks/github', { method: 'GET' }, socketEnv());
    expect(response.status).toBe(404);
  });
});

describe('mounting from settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drefyn-api-hook-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exists only when a webhook secret file is set', async () => {
    const { startApi } = await import('../src/start.ts');
    const { deps } = fakeDeps();
    const base = {
      DREFYN_API_RATE_LIMIT_KEY: randomBytes(32).toString('base64url'),
      DREFYN_API_PORT: '0',
    };
    const seams = {
      logger: deps.logger,
      openDatabase: () => Promise.resolve(deps.db),
      openPublished: () => Promise.resolve(deps.published),
      flags: deps.flags,
    };
    const without = await startApi(base, seams);
    try {
      const response = await fetchLocal(without.port);
      expect(response).toBe(404);
    } finally {
      await without.stop();
    }
    const file = join(dir, 'hook');
    writeFileSync(file, 'a-webhook-secret-for-api-tests\n', { mode: 0o600 });
    const withHook = await startApi({ ...base, DREFYN_GITHUB_WEBHOOK_SECRET_FILE: file }, seams);
    try {
      expect(await fetchLocal(withHook.port)).toBe(401);
    } finally {
      await withHook.stop();
    }
  });

  it('refuses to start when the secret file cannot be read, naming the key only', async () => {
    const { describeStartFailure, startApi } = await import('../src/start.ts');
    const { deps } = fakeDeps();
    let failure: unknown = null;
    try {
      await startApi(
        {
          DREFYN_API_RATE_LIMIT_KEY: randomBytes(32).toString('base64url'),
          DREFYN_API_PORT: '0',
          DREFYN_GITHUB_WEBHOOK_SECRET_FILE: join(dir, 'absent'),
        },
        {
          logger: deps.logger,
          openDatabase: () => Promise.resolve(deps.db),
          openPublished: () => Promise.resolve(deps.published),
          flags: deps.flags,
        },
      );
    } catch (error) {
      failure = error;
    }
    expect(describeStartFailure(failure)).toMatchObject({
      error: 'GitHubConfigError',
      key: 'DREFYN_GITHUB_WEBHOOK_SECRET_FILE',
    });
  });
});

// The started server, called the way GitHub would: an unsigned POST.
async function fetchLocal(port: number): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/webhooks/github`, {
    method: 'POST',
    body: '{}',
  });
  await response.body?.cancel();
  return response.status;
}

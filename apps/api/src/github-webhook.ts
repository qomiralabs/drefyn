import type { WebhookReceiver } from '@drefyn/github';
import type { Hono } from 'hono';
import type { ApiEnv } from './app.ts';
import { ApiError, errorResponse } from './errors.ts';

export const GITHUB_WEBHOOK_PATH = '/webhooks/github';

// GitHub's deliveries. No API key: the HMAC over the raw body is the proof, and the receiver
// checks it before reading anything else. The service body limit still runs first.
export function mountGitHubWebhook(app: Hono<ApiEnv>, receiver: WebhookReceiver): void {
  app.post(GITHUB_WEBHOOK_PATH, async (c) => {
    const body = new Uint8Array(await c.req.arrayBuffer());
    const outcome = await receiver.receive({
      body,
      signature: c.req.header('x-hub-signature-256'),
      deliveryId: c.req.header('x-github-delivery'),
      event: c.req.header('x-github-event'),
    });
    if (outcome.status === 202) {
      return c.json({ status: 'accepted' }, 202, { 'cache-control': 'no-store' });
    }
    return errorResponse(new ApiError(outcome.code));
  });
}

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { isGitHubId, noopLogger, type GitHubLogger, type LogFields } from './types.ts';

// GitHub caps a payload at 25 MB but no event we use comes close; a push lists 20 commits.
export const WEBHOOK_MAX_BODY_BYTES = 5 * 1024 * 1024;

const MIN_SECRET_BYTES = 16;
const SIGNATURE = /^sha256=([0-9a-f]{64})$/;
// GitHub's delivery header is a GUID. Anything else is not from GitHub and never reaches a log.
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVENT = /^[a-z_]{1,64}$/;
const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

export const isDeliveryId = (value: unknown): value is string =>
  typeof value === 'string' && GUID.test(value);
export const isEventName = (value: unknown): value is string =>
  typeof value === 'string' && EVENT.test(value);

// HMAC SHA-256 over the raw bytes, compared in constant time. A header of the wrong shape is
// refused before the compare: its length is no secret.
export function verifyGitHubWebhook(
  rawBody: Uint8Array,
  signature256: string | undefined,
  secret: Uint8Array,
): boolean {
  if (secret.byteLength === 0) throw new TypeError('github: empty webhook secret');
  const hex = SIGNATURE.exec(signature256 ?? '')?.[1];
  if (hex === undefined) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(hex, 'hex'));
}

export interface DeliveryClaim {
  readonly deliveryId: string;
  // The SHA-256 of the raw body: a captured body and signature sent again under a fresh
  // delivery id is the same body.
  readonly bodySha256: Uint8Array;
  readonly event: string;
}

export interface DeliveryLedger {
  // 'replayed' when the delivery id or the body was taken before.
  claim(claim: DeliveryClaim): Promise<'new' | 'replayed'>;
  // Forgets a delivery whose handling failed, so GitHub's redelivery is taken.
  release(deliveryId: string): Promise<void>;
}

export interface VerifiedDelivery {
  readonly deliveryId: string;
  readonly event: string;
  readonly action: string | null;
  readonly installationId: number | null;
  readonly repositoryId: number | null;
  // The parsed body. Whoever reads more of it validates what it reads.
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface WebhookRequest {
  readonly body: Uint8Array;
  readonly signature: string | undefined;
  readonly deliveryId: string | undefined;
  readonly event: string | undefined;
  readonly requestId?: string;
}

export type WebhookRefusal =
  | 'github.too_large'
  | 'github.signature_invalid'
  | 'github.delivery_invalid'
  | 'github.payload_invalid'
  | 'github.delivery_replayed'
  | 'github.unavailable';

export type WebhookOutcome =
  | { readonly status: 202; readonly code: 'github.accepted' }
  | { readonly status: 400; readonly code: 'github.delivery_invalid' | 'github.payload_invalid' }
  | { readonly status: 401; readonly code: 'github.signature_invalid' }
  | { readonly status: 409; readonly code: 'github.delivery_replayed' }
  | { readonly status: 413; readonly code: 'github.too_large' }
  | { readonly status: 503; readonly code: 'github.unavailable' };

export interface WebhookReceiverOptions {
  readonly secret: Uint8Array;
  readonly ledger: DeliveryLedger;
  readonly onDelivery?: (delivery: VerifiedDelivery) => Promise<void>;
  readonly logger?: GitHubLogger;
  readonly maxBodyBytes?: number;
}

export interface WebhookReceiver {
  receive(request: WebhookRequest): Promise<WebhookOutcome>;
}

const githubId = z.number().refine(isGitHubId);
const payloadShape = z.looseObject({
  action: z.string().max(64).optional(),
  installation: z.looseObject({ id: githubId }).optional(),
  repository: z.looseObject({ id: githubId }).optional(),
});

const decoder = new TextDecoder('utf-8', { fatal: true });

function parsePayload(body: Uint8Array): z.infer<typeof payloadShape> | null {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(body));
  } catch {
    return null;
  }
  const parsed = payloadShape.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const STATUS: Readonly<Record<WebhookRefusal, WebhookOutcome['status']>> = {
  'github.too_large': 413,
  'github.signature_invalid': 401,
  'github.delivery_invalid': 400,
  'github.payload_invalid': 400,
  'github.delivery_replayed': 409,
  'github.unavailable': 503,
};

export function createWebhookReceiver(options: WebhookReceiverOptions): WebhookReceiver {
  if (options.secret.byteLength < MIN_SECRET_BYTES) {
    throw new TypeError('github: the webhook secret is too short');
  }
  const secret = new Uint8Array(options.secret);
  const logger = options.logger ?? noopLogger;
  const onDelivery = options.onDelivery ?? (() => Promise.resolve());
  const maxBodyBytes = options.maxBodyBytes ?? WEBHOOK_MAX_BODY_BYTES;

  return Object.freeze({
    async receive(request: WebhookRequest): Promise<WebhookOutcome> {
      // Only header values of a known shape are logged, so a forged header cannot write a line.
      const fields: Record<string, string | number> = {};
      if (isDeliveryId(request.deliveryId)) fields['delivery_id'] = request.deliveryId;
      if (isEventName(request.event)) fields['event'] = request.event;
      if (typeof request.requestId === 'string' && REQUEST_ID.test(request.requestId)) {
        fields['request_id'] = request.requestId;
      }
      const refuse = (code: WebhookRefusal): WebhookOutcome => {
        logger.warn('github.webhook_refused', { reason: code, ...fields });
        return { status: STATUS[code], code } as WebhookOutcome;
      };
      const failed = (stage: string, error: unknown): void => {
        const name = error instanceof Error ? error.name : typeof error;
        logger.warn('github.webhook_failed', { stage, ...fields, error: name } satisfies LogFields);
      };

      if (request.body.byteLength > maxBodyBytes) return refuse('github.too_large');
      if (!verifyGitHubWebhook(request.body, request.signature, secret)) {
        return refuse('github.signature_invalid');
      }
      if (!isDeliveryId(request.deliveryId) || !isEventName(request.event)) {
        return refuse('github.delivery_invalid');
      }
      const deliveryId = request.deliveryId;
      const event = request.event;
      const payload = parsePayload(request.body);
      if (payload === null) return refuse('github.payload_invalid');
      const installationId = payload.installation?.id ?? null;
      const repositoryId = payload.repository?.id ?? null;
      if (installationId !== null) fields['installation_id'] = installationId;
      if (repositoryId !== null) fields['repository_id'] = repositoryId;

      const bodySha256 = new Uint8Array(createHash('sha256').update(request.body).digest());
      let claimed: 'new' | 'replayed';
      try {
        claimed = await options.ledger.claim({ deliveryId, bodySha256, event });
      } catch (error) {
        failed('claim', error);
        return { status: 503, code: 'github.unavailable' };
      }
      if (claimed === 'replayed') return refuse('github.delivery_replayed');

      try {
        await onDelivery({
          deliveryId,
          event,
          action: payload.action ?? null,
          installationId,
          repositoryId,
          payload,
        });
      } catch (error) {
        failed('deliver', error);
        try {
          await options.ledger.release(deliveryId);
        } catch (releaseError) {
          failed('release', releaseError);
        }
        return { status: 503, code: 'github.unavailable' };
      }
      logger.info('github.webhook_accepted', fields);
      return { status: 202, code: 'github.accepted' };
    },
  });
}

import { createHash, createHmac, randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import {
  createWebhookReceiver,
  verifyGitHubWebhook,
  WEBHOOK_MAX_BODY_BYTES,
  type DeliveryClaim,
  type DeliveryLedger,
  type VerifiedDelivery,
  type WebhookRequest,
} from '../src/index.ts';
import { captureLogs } from './support/logs.ts';

const secret = new TextEncoder().encode('a-webhook-secret-for-tests-only');
const encode = (text: string) => new TextEncoder().encode(text);
const sign = (body: Uint8Array, key: Uint8Array = secret) =>
  `sha256=${createHmac('sha256', key).update(body).digest('hex')}`;

// A marker that would show up in any log line that leaked the body.
const MARKER = 'body-marker-7f3a';
const pushBody = encode(
  JSON.stringify({
    ref: 'refs/heads/main',
    after: 'a'.repeat(40),
    installation: { id: 77 },
    repository: { id: 4001, full_name: 'acme/docs' },
    head_commit: { message: MARKER, author: { email: 'someone@example.com' } },
  }),
);

describe('verifyGitHubWebhook', () => {
  it('accepts the signature GitHub computes over the raw body', () => {
    expect(verifyGitHubWebhook(pushBody, sign(pushBody), secret)).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['without the prefix', sign(pushBody).slice('sha256='.length)],
    ['with the sha1 prefix', sign(pushBody).replace('sha256=', 'sha1=')],
    ['truncated', sign(pushBody).slice(0, -2)],
    ['one character longer', `${sign(pushBody)}0`],
    ['in upper case', sign(pushBody).toUpperCase().replace('SHA256=', 'sha256=')],
    ['with a flipped digit', sign(pushBody).replace(/.$/, (c) => (c === '0' ? '1' : '0'))],
    ['with whitespace', ` ${sign(pushBody)}`],
    ['made with another secret', sign(pushBody, encode('another-secret-entirely'))],
    ['not hex', `sha256=${'z'.repeat(64)}`],
  ])('refuses a signature that is %s', (_name, signature) => {
    expect(verifyGitHubWebhook(pushBody, signature, secret)).toBe(false);
  });

  it('refuses the same signature on any other body', () => {
    expect(verifyGitHubWebhook(encode('{"a":1}'), sign(encode('{"a":2}')), secret)).toBe(false);
  });

  it('throws on an empty secret, which would make every forger right', () => {
    expect(() => verifyGitHubWebhook(pushBody, sign(pushBody), new Uint8Array())).toThrow(
      TypeError,
    );
  });

  it('never verifies a random signature for a random body', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 512 }),
        fc.stringMatching(/^[0-9a-f]{64}$/),
        (body, hex) => {
          fc.pre(`sha256=${hex}` !== sign(body));
          expect(verifyGitHubWebhook(body, `sha256=${hex}`, secret)).toBe(false);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('never verifies one body with the signature of another', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 256 }), fc.uint8Array({ maxLength: 256 }), (a, b) => {
        fc.pre(Buffer.compare(Buffer.from(a), Buffer.from(b)) !== 0);
        expect(verifyGitHubWebhook(a, sign(b), secret)).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it('never verifies with a random secret', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 64 }), (other) => {
        fc.pre(Buffer.compare(Buffer.from(other), Buffer.from(secret)) !== 0);
        expect(verifyGitHubWebhook(pushBody, sign(pushBody, other), secret)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});

// The ledger the database keeps, in memory: a delivery id or a body seen once is a replay.
function memoryLedger() {
  const ids = new Set<string>();
  const bodies = new Set<string>();
  const claims: DeliveryClaim[] = [];
  const claim = vi.fn((input: DeliveryClaim): Promise<'new' | 'replayed'> => {
    claims.push(input);
    const body = Buffer.from(input.bodySha256).toString('hex');
    if (ids.has(input.deliveryId) || bodies.has(body)) return Promise.resolve('replayed');
    ids.add(input.deliveryId);
    bodies.add(body);
    return Promise.resolve('new');
  });
  const release = vi.fn((deliveryId: string) => {
    ids.delete(deliveryId);
    bodies.clear();
    return Promise.resolve();
  });
  const ledger: DeliveryLedger = { claim, release };
  return { ledger, claim, release, claims };
}

function setup(onDelivery?: (delivery: VerifiedDelivery) => Promise<void>) {
  const logs = captureLogs();
  const { ledger, claim, release, claims } = memoryLedger();
  const delivered: VerifiedDelivery[] = [];
  const receiver = createWebhookReceiver({
    secret,
    ledger,
    logger: logs.logger,
    onDelivery:
      onDelivery ??
      ((delivery) => {
        delivered.push(delivery);
        return Promise.resolve();
      }),
  });
  return { receiver, logs, claim, release, claims, delivered };
}

const request = (overrides: Partial<WebhookRequest> = {}): WebhookRequest => ({
  body: pushBody,
  signature: sign(pushBody),
  deliveryId: randomUUID(),
  event: 'push',
  requestId: 'req-1',
  ...overrides,
});

describe('the webhook receiver', () => {
  it('accepts a signed delivery once and passes on the ids it carries', async () => {
    const { receiver, logs, claims, delivered } = setup();
    const req = request();
    await expect(receiver.receive(req)).resolves.toEqual({ status: 202, code: 'github.accepted' });
    expect(claims).toEqual([
      {
        deliveryId: req.deliveryId,
        event: 'push',
        bodySha256: new Uint8Array(createHash('sha256').update(pushBody).digest()),
      },
    ]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      deliveryId: req.deliveryId,
      event: 'push',
      installationId: 77,
      repositoryId: 4001,
    });
    expect(logs.lines).toEqual([
      {
        level: 'info',
        event: 'github.webhook_accepted',
        fields: {
          delivery_id: req.deliveryId,
          event: 'push',
          installation_id: 77,
          repository_id: 4001,
          request_id: 'req-1',
        },
      },
    ]);
  });

  it('passes a delivery with no installation or repository with nulls', async () => {
    const { receiver, delivered } = setup();
    const body = encode(JSON.stringify({ zen: 'Keep it logically awesome.', hook_id: 1 }));
    await expect(
      receiver.receive(request({ body, signature: sign(body), event: 'ping' })),
    ).resolves.toMatchObject({ status: 202 });
    expect(delivered[0]).toMatchObject({ event: 'ping', installationId: null, repositoryId: null });
  });

  it.each([
    ['missing', undefined],
    ['bad', sign(encode('another body'))],
    ['truncated', sign(pushBody).slice(0, 40)],
  ])('refuses a %s signature, logs ids only and records nothing', async (_name, signature) => {
    const { receiver, logs, claim, delivered } = setup();
    const req = request({ signature });
    await expect(receiver.receive(req)).resolves.toEqual({
      status: 401,
      code: 'github.signature_invalid',
    });
    expect(claim).not.toHaveBeenCalled();
    expect(delivered).toEqual([]);
    expect(logs.lines).toEqual([
      {
        level: 'warn',
        event: 'github.webhook_refused',
        fields: {
          reason: 'github.signature_invalid',
          delivery_id: req.deliveryId,
          event: 'push',
          request_id: 'req-1',
        },
      },
    ]);
    expect(logs.text()).not.toContain(MARKER);
    expect(logs.text()).not.toContain('someone@example.com');
  });

  it('refuses a replayed delivery id, and a replayed signature under a fresh id', async () => {
    const { receiver, logs, delivered } = setup();
    const first = request();
    await receiver.receive(first);
    await expect(receiver.receive(first)).resolves.toEqual({
      status: 409,
      code: 'github.delivery_replayed',
    });
    await expect(receiver.receive({ ...first, deliveryId: randomUUID() })).resolves.toEqual({
      status: 409,
      code: 'github.delivery_replayed',
    });
    expect(delivered).toHaveLength(1);
    const refusals = logs.lines.filter((line) => line.event === 'github.webhook_refused');
    expect(refusals).toHaveLength(2);
    for (const line of refusals) {
      expect(line.fields).toMatchObject({ reason: 'github.delivery_replayed', event: 'push' });
      expect(Object.keys(line.fields).sort()).toEqual(
        ['delivery_id', 'event', 'installation_id', 'reason', 'repository_id', 'request_id'].sort(),
      );
    }
    expect(logs.text()).not.toContain(MARKER);
    expect(logs.text()).not.toContain(sign(pushBody).slice(7));
  });

  it('never logs a delivery id or event name that is not well formed', async () => {
    const { receiver, logs } = setup();
    await expect(
      receiver.receive(
        request({ signature: undefined, deliveryId: 'x\nforged log line', event: 'Push Event!' }),
      ),
    ).resolves.toMatchObject({ status: 401 });
    expect(logs.lines[0]?.fields).toEqual({
      reason: 'github.signature_invalid',
      request_id: 'req-1',
    });
  });

  it.each([
    ['missing', undefined],
    ['not a GUID', 'delivery-1'],
  ])('refuses a signed delivery whose id is %s', async (_name, deliveryId) => {
    const { receiver, claim } = setup();
    await expect(receiver.receive(request({ deliveryId }))).resolves.toEqual({
      status: 400,
      code: 'github.delivery_invalid',
    });
    expect(claim).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['malformed', 'Push'],
  ])('refuses a signed delivery whose event is %s', async (_name, event) => {
    const { receiver } = setup();
    await expect(receiver.receive(request({ event }))).resolves.toEqual({
      status: 400,
      code: 'github.delivery_invalid',
    });
  });

  it.each([
    ['not JSON', '{"installation":'],
    ['not an object', '[1,2]'],
    ['an installation id that is not a positive integer', '{"installation":{"id":-3}}'],
    ['a repository id that is a string', '{"repository":{"id":"4001"}}'],
  ])('refuses a signed body that is %s', async (_name, text) => {
    const { receiver, claim, logs } = setup();
    const body = encode(text);
    await expect(receiver.receive(request({ body, signature: sign(body) }))).resolves.toEqual({
      status: 400,
      code: 'github.payload_invalid',
    });
    expect(claim).not.toHaveBeenCalled();
    expect(logs.lines[0]?.fields['reason']).toBe('github.payload_invalid');
  });

  it('refuses a body over the cap before computing anything', async () => {
    const { receiver, claim } = setup();
    const body = new Uint8Array(WEBHOOK_MAX_BODY_BYTES + 1);
    await expect(receiver.receive(request({ body, signature: sign(body) }))).resolves.toEqual({
      status: 413,
      code: 'github.too_large',
    });
    expect(claim).not.toHaveBeenCalled();
    expect(WEBHOOK_MAX_BODY_BYTES).toBe(5 * 1024 * 1024);
  });

  it('gives the delivery back when the handler fails, so GitHub can send it again', async () => {
    let fail = true;
    const { receiver, release, logs } = setup(() =>
      fail ? Promise.reject(new Error(`boom ${MARKER}`)) : Promise.resolve(),
    );
    const req = request();
    await expect(receiver.receive(req)).resolves.toEqual({
      status: 503,
      code: 'github.unavailable',
    });
    expect(release).toHaveBeenCalledWith(req.deliveryId);
    fail = false;
    await expect(receiver.receive(req)).resolves.toMatchObject({ status: 202 });
    expect(logs.text()).not.toContain(MARKER);
    expect(logs.lines[0]).toMatchObject({
      level: 'warn',
      event: 'github.webhook_failed',
      fields: { stage: 'deliver', delivery_id: req.deliveryId, error: 'Error' },
    });
  });

  it('answers unavailable when the ledger cannot be reached, and when release fails too', async () => {
    const logs = captureLogs();
    const receiver = createWebhookReceiver({
      secret,
      logger: logs.logger,
      ledger: {
        claim: () => Promise.reject(new Error('down')),
        release: () => Promise.reject(new Error('down')),
      },
    });
    await expect(receiver.receive(request())).resolves.toEqual({
      status: 503,
      code: 'github.unavailable',
    });
    const failing = createWebhookReceiver({
      secret,
      logger: logs.logger,
      ledger: {
        claim: () => Promise.resolve('new'),
        release: () => Promise.reject(new Error('x')),
      },
      onDelivery: () => Promise.reject(new Error('handler')),
    });
    await expect(failing.receive(request())).resolves.toEqual({
      status: 503,
      code: 'github.unavailable',
    });
    expect(logs.lines.map((line) => line.fields['stage'])).toEqual(['claim', 'deliver', 'release']);
  });

  it('accepts with no handler and no logger, which is how it runs before git sync', async () => {
    const receiver = createWebhookReceiver({ secret, ledger: memoryLedger().ledger });
    await expect(receiver.receive(request())).resolves.toMatchObject({ status: 202 });
  });

  it('refuses to start with a short secret', () => {
    expect(() =>
      createWebhookReceiver({ secret: encode('short'), ledger: memoryLedger().ledger }),
    ).toThrow(TypeError);
  });
});

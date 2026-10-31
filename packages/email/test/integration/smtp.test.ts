// Delivery to Mailpit over implicit TLS with AUTH, the way hosted sends to its relay.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderMail, type SendResult } from '../../src/index.ts';
import { FIXTURE_MESSAGES } from '../fixtures/messages.ts';
import { ORIGIN } from '../support.ts';
import { mailpit, smtpServer, type ServerRecord } from '../support/servers.ts';
import { FROM, MAILPIT, TO, config, credentials, harness, implicitEnv, plainEnv } from './stack.ts';

const inbox = mailpit(MAILPIT.implicit.api);
const FROM_NAME = 'Drefyn "Ops" <ops@evil.test>, x';
const HEADER = 'X-Drefyn-Idempotency-Key';

beforeAll(async () => {
  await inbox.clear();
});

const lines = (text: string) => text.replace(/\r\n/g, '\n').replace(/\n+$/, '');

function ok(result: SendResult) {
  if (!result.ok) throw new Error(`send failed: ${result.error.code}`);
  return result.value;
}

describe('delivery to Mailpit', () => {
  const { mailer } = harness(
    config(
      implicitEnv({ DREFYN_EMAIL_FROM_NAME: FROM_NAME, DREFYN_EMAIL_IDEMPOTENCY_HEADER: HEADER }),
    ),
  );
  afterAll(async () => {
    await mailer.drain(1000);
  });

  it.each(FIXTURE_MESSAGES)('delivers %s with both parts intact', async (name, message) => {
    const key = `fixture:${name}`;
    const sent = ok(await mailer.send(TO, message, { idempotencyKey: key }));
    const rendered = await renderMail(message, { linkOrigin: ORIGIN });
    if (!rendered.ok) throw new Error('fixture did not render');

    const [stored, ...more] = await inbox.byMessageId(sent.messageId);
    expect(more).toHaveLength(0);
    if (stored === undefined) throw new Error('not delivered');
    expect(stored.Subject).toBe(rendered.value.subject);
    expect(lines(stored.Text)).toBe(lines(rendered.value.text));
    expect(lines(stored.HTML)).toBe(lines(rendered.value.html));
    expect(stored.From).toEqual({ Name: FROM_NAME, Address: FROM });
    expect(stored.To).toEqual([{ Name: '', Address: TO }]);

    const headers = await inbox.headers(stored.ID);
    expect(headers['Auto-Submitted']).toEqual(['auto-generated']);
    expect(headers[HEADER]).toEqual([key]);
    expect(headers['Message-Id'] ?? headers['Message-ID']).toEqual([sent.messageId]);
  });

  it('quotes the display name instead of reading it as addresses', async () => {
    const [name, message] = FIXTURE_MESSAGES[0] ?? [];
    if (message === undefined || name === undefined) throw new Error('no fixtures');
    const sent = ok(await mailer.send(TO, message, { idempotencyKey: 'quote:1' }));
    const [stored] = await inbox.byMessageId(sent.messageId);
    if (stored === undefined) throw new Error('not delivered');
    const raw = await inbox.raw(stored.ID);
    expect(raw).toMatch(/^From: "Drefyn \\"Ops\\" <ops@evil\.test>, x" <mail@drefyn\.test>\r?$/m);
  });

  it('gives a second send with the same key the same Message-ID', async () => {
    const [, message] = FIXTURE_MESSAGES[0] ?? [];
    if (message === undefined) throw new Error('no fixtures');
    const a = ok(await mailer.send(TO, message, { idempotencyKey: 'same:1' }));
    const b = ok(await mailer.send(TO, message, { idempotencyKey: 'same:1' }));
    expect(b.messageId).toBe(a.messageId);
    expect(await inbox.byMessageId(a.messageId)).toHaveLength(2);
  });

  it('reports send time to Mailpit on loopback', async () => {
    const [, message] = FIXTURE_MESSAGES[0] ?? [];
    if (message === undefined) throw new Error('no fixtures');
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const started = performance.now();
      ok(await mailer.send(TO, message, { idempotencyKey: `timing:${String(i)}` }));
      times.push(performance.now() - started);
    }
    times.sort((x, y) => x - y);
    const at = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))] ?? 0;
    process.stdout.write(
      `send to Mailpit, implicit TLS and AUTH, 20 sends: p50 ${at(0.5).toFixed(1)} ms, p95 ${at(0.95).toFixed(1)} ms\n`,
    );
    expect(at(0.95)).toBeLessThan(5000);
  });
});

describe('AUTH', () => {
  it('sends the real password, not the redacted form', async () => {
    const cfg = config(implicitEnv());
    // The config only ever prints the redacted form.
    expect(JSON.stringify(cfg)).not.toContain(credentials().password);
    const { mailer } = harness(cfg);
    const [, message] = FIXTURE_MESSAGES[0] ?? [];
    if (message === undefined) throw new Error('no fixtures');
    // Mailpit refuses every other password, so a delivery proves the real one arrived.
    ok(await mailer.send(TO, message, { idempotencyKey: 'auth:real' }));

    const wrong = harness(config(implicitEnv({ DREFYN_SMTP_PASSWORD: '[redacted]' })));
    const refused = await wrong.mailer.send(TO, message, { idempotencyKey: 'auth:redacted' });
    expect(refused).toEqual({
      ok: false,
      error: { code: 'email.auth_failed', retryable: false, smtpReplyClass: 5 },
    });
    await Promise.all([mailer.drain(1000), wrong.mailer.drain(1000)]);
  });
});

describe('retry', () => {
  let relay: ServerRecord;
  beforeAll(async () => {
    // The first MAIL FROM is deferred, the second goes through.
    relay = await smtpServer({
      reply: (command, connection) =>
        connection === 0 && command.startsWith('MAIL') ? '451 4.3.0 try again' : undefined,
    });
  });
  afterAll(async () => {
    await relay.close();
  });

  it('keeps the Message-ID across a retry', async () => {
    const { mailer } = harness(config(plainEnv(relay.port)));
    const [, message] = FIXTURE_MESSAGES[0] ?? [];
    if (message === undefined) throw new Error('no fixtures');
    const sent = ok(await mailer.send(TO, message, { idempotencyKey: 'retry:1' }));
    expect(sent.attempts).toBe(2);
    expect(relay.connections).toBe(2);
    expect(relay.messages).toHaveLength(1);
    const id = /^Message-ID: (.*)$/im.exec(relay.messages[0] ?? '')?.[1];
    expect(id).toBe(sent.messageId);
    await mailer.drain(1000);
  });
});

// The SMTP transport against loopback servers in plaintext, so it runs with the unit tests
// and needs no containers. TLS, AUTH and Mailpit are in test/integration.
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSmtpTransport,
  renderMail,
  type Envelope,
  type RenderedMail,
  type SmtpConfig,
  type TransportPhase,
} from '../src/index.ts';
import { messageIdFor } from '../src/message-id.ts';
import { ORIGIN, signIn, smtpConfig } from './support.ts';
import { smtpServer, type Script, type ServerRecord } from './support/servers.ts';
import type { NormalizedEmailAddress } from '@drefyn/address';

const servers: ServerRecord[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function server(script?: Script): Promise<ServerRecord> {
  const s = await smtpServer(script);
  servers.push(s);
  return s;
}

function plain(port: number, patch: Record<string, string> = {}): SmtpConfig {
  const config = smtpConfig({
    DREFYN_SMTP_HOST: '127.0.0.1',
    DREFYN_SMTP_PORT: String(port),
    DREFYN_SMTP_TLS: 'none',
    DREFYN_SMTP_ALLOW_PLAINTEXT: 'true',
    DREFYN_SMTP_SOCKET_TIMEOUT_MS: '1000',
    ...patch,
  });
  if (config.kind !== 'smtp') throw new Error('expected smtp config');
  return config.smtp;
}

const KEY = 'code:key-sentinel-7f3a';
const envelope: Envelope = {
  from: 'mail@drefyn.test' as NormalizedEmailAddress,
  fromName: 'Drefyn "Ops" <ops@evil.test>, x',
  to: 'person@example.com' as NormalizedEmailAddress,
  replyTo: 'help@drefyn.test' as NormalizedEmailAddress,
  messageId: messageIdFor(KEY, 'drefyn.test'),
  idempotencyKey: KEY,
  headers: new Map([
    ['Auto-Submitted', 'auto-generated'],
    ['X-Idempotency-Key', KEY],
  ]),
};

async function rendered(): Promise<RenderedMail> {
  const result = await renderMail(signIn(), { linkOrigin: ORIGIN });
  if (!result.ok) throw new Error('fixture did not render');
  return result.value;
}

const header = (message: string, name: string) =>
  new RegExp(`^${name}: (.*(?:\\r\\n[ \\t].*)*)`, 'im').exec(message)?.[1];

describe('SMTP transport', () => {
  it('sends one recipient with an explicit envelope, then quits', async () => {
    const s = await server();
    const transport = createSmtpTransport(plain(s.port));
    expect(transport.kind).toBe('smtp');
    const phases: TransportPhase[] = [];
    const result = await transport.deliver(
      envelope,
      await rendered(),
      new AbortController().signal,
      (p) => phases.push(p),
    );
    expect(result).toEqual({ ok: true, value: { messageId: envelope.messageId } });
    expect(phases).toEqual(['connect', 'envelope', 'data', 'after_data']);
    expect(s.commands[0]).toEqual([
      'EHLO drefyn.test',
      'MAIL FROM:<mail@drefyn.test>',
      'RCPT TO:<person@example.com>',
      'DATA',
      'QUIT',
    ]);
    // The relay sees the close too, after QUIT.
    await until(() => s.open === 0);
    await transport.close();
  });

  it('writes the headers it was given and quotes the display name', async () => {
    const s = await server();
    const transport = createSmtpTransport(plain(s.port));
    await transport.deliver(envelope, await rendered(), new AbortController().signal);
    const message = s.messages[0] ?? '';
    expect(header(message, 'From')).toBe(
      '"Drefyn \\"Ops\\" <ops@evil.test>, x" <mail@drefyn.test>',
    );
    expect(header(message, 'To')).toBe('person@example.com');
    expect(header(message, 'Reply-To')).toBe('help@drefyn.test');
    expect(header(message, 'Message-ID')).toBe(envelope.messageId);
    expect(header(message, 'Auto-Submitted')).toBe('auto-generated');
    expect(header(message, 'X-Idempotency-Key')).toBe(KEY);
    expect(header(message, 'Subject')).toBeDefined();
    expect(message).toMatch(/^Content-Type: multipart\/alternative/im);
    expect(message).toMatch(/^Content-Type: text\/plain; charset=utf-8/im);
    expect(message).toMatch(/^Content-Type: text\/html; charset=utf-8/im);
    // The key goes out only in the header the operator configured.
    expect(message.split(KEY)).toHaveLength(2);
    await transport.close();
  });

  it('answers at once and opens nothing for a signal that already fired', async () => {
    const s = await server();
    const transport = createSmtpTransport(plain(s.port));
    const controller = new AbortController();
    controller.abort();
    expect(await transport.deliver(envelope, await rendered(), controller.signal)).toEqual({
      ok: false,
      error: { code: 'email.timeout', phase: 'connect' },
    });
    expect(s.connections).toBe(0);
    await transport.close();
  });

  it('settles an abort after DATA as unknown_outcome, once the socket is closed', async () => {
    const s = await server({ afterData: () => 'stall' });
    const transport = createSmtpTransport(
      plain(s.port, { DREFYN_SMTP_SOCKET_TIMEOUT_MS: '30000' }),
    );
    const controller = new AbortController();
    const phases: TransportPhase[] = [];
    const pending = transport.deliver(envelope, await rendered(), controller.signal, (p) => {
      phases.push(p);
    });
    await until(() => s.messages.length === 1);
    expect(s.open).toBe(1);
    controller.abort();
    expect(await pending).toEqual({
      ok: false,
      error: { code: 'email.unknown_outcome', phase: 'after_data' },
    });
    expect(phases.at(-1)).toBe('after_data');
    await until(() => s.open === 0);
    expect(s.closedAt).toHaveLength(1);
    await transport.close();
  });

  it('settles an abort while waiting for the greeting as a timeout', async () => {
    const s = await server({ greeting: () => 'stall' });
    const transport = createSmtpTransport(
      plain(s.port, { DREFYN_SMTP_GREETING_TIMEOUT_MS: '30000' }),
    );
    const controller = new AbortController();
    const pending = transport.deliver(envelope, await rendered(), controller.signal);
    await until(() => s.connections === 1);
    controller.abort();
    expect(await pending).toEqual({
      ok: false,
      error: { code: 'email.timeout', phase: 'connect' },
    });
    await until(() => s.open === 0);
    await transport.close();
  });

  it('closes every connection still open on close, and refuses sends after it', async () => {
    const s = await server({ greeting: () => 'stall' });
    const transport = createSmtpTransport(
      plain(s.port, { DREFYN_SMTP_GREETING_TIMEOUT_MS: '30000' }),
    );
    const mail = await rendered();
    const pending = [
      transport.deliver(envelope, mail, new AbortController().signal),
      transport.deliver(envelope, mail, new AbortController().signal),
    ];
    await until(() => s.open === 2);
    await transport.close();
    for (const result of await Promise.all(pending)) {
      expect(result).toEqual({ ok: false, error: { code: 'email.timeout', phase: 'connect' } });
    }
    await until(() => s.open === 0);
    expect(await transport.deliver(envelope, mail, new AbortController().signal)).toEqual({
      ok: false,
      error: { code: 'email.connect_failed', phase: 'connect' },
    });
    expect(s.connections).toBe(2);
  });

  it('maps a reply to the final dot by its class', async () => {
    const s = await server({ afterData: () => `554 5.7.1 spam person@example.com` });
    const transport = createSmtpTransport(plain(s.port));
    expect(
      await transport.deliver(envelope, await rendered(), new AbortController().signal),
    ).toEqual({
      ok: false,
      error: { code: 'email.rejected', phase: 'data', smtpReplyClass: 5 },
    });
    await transport.close();
  });

  it('reports connect_failed for a relay that is not there', async () => {
    const s = await server();
    const port = s.port;
    await s.close();
    servers.length = 0;
    const transport = createSmtpTransport(plain(port));
    expect(
      await transport.deliver(envelope, await rendered(), new AbortController().signal),
    ).toEqual({
      ok: false,
      error: { code: 'email.connect_failed', phase: 'connect' },
    });
    await transport.close();
  });
});

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!condition()) throw new Error('condition never held');
}

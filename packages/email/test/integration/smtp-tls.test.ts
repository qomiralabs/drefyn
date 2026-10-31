// The TLS rules: required by default, certificates always checked, a private CA through
// DREFYN_SMTP_CA_FILE, and plaintext only with the opt in. A failure is never retried in
// plaintext.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { logEmailConfig, parseEmailConfig, type SendResult } from '../../src/index.ts';
import { FIXTURE_MESSAGES } from '../fixtures/messages.ts';
import { recorder } from '../support.ts';
import { mailpit, smtpServer, type ServerRecord } from '../support/servers.ts';
import {
  FAST,
  FROM,
  MAILPIT,
  TO,
  certFile,
  config,
  credentials,
  harness,
  implicitEnv,
  plainEnv,
  readCert,
} from './stack.ts';

const message = FIXTURE_MESSAGES[0]?.[1];
if (message === undefined) throw new Error('no fixtures');

const TLS_FAILED = { ok: false, error: { code: 'email.tls_failed', retryable: false } } as const;

async function sendWith(env: Record<string, string | undefined>, key: string): Promise<SendResult> {
  const { mailer } = harness(config({ ...FAST, ...env }));
  if (message === undefined) throw new Error('no fixtures');
  const result = await mailer.send(TO, message, { idempotencyKey: key });
  await mailer.drain(1000);
  return result;
}

const starttlsEnv = (patch: Record<string, string | undefined> = {}) => ({
  DREFYN_SMTP_PORT: String(MAILPIT.starttls.smtp),
  DREFYN_SMTP_TLS: 'starttls',
  DREFYN_SMTP_CA_FILE: certFile('ca.pem'),
  DREFYN_SMTP_USER: credentials().user,
  DREFYN_SMTP_PASSWORD: credentials().password,
  ...patch,
});

const plainInbox = mailpit(MAILPIT.plain.api);

describe('STARTTLS', () => {
  it('delivers with STARTTLS required and the private CA', async () => {
    const result = await sendWith(starttlsEnv(), 'tls:starttls');
    expect(result.ok).toBe(true);
  });

  it('refuses a server that does not offer STARTTLS, and sends nothing in plaintext', async () => {
    const before = await plainInbox.count();
    const result = await sendWith(
      { DREFYN_SMTP_PORT: String(MAILPIT.plain.smtp), DREFYN_SMTP_TLS: 'starttls' },
      'tls:no-starttls',
    );
    expect(result).toEqual(TLS_FAILED);
    expect(await plainInbox.count()).toBe(before);
  });

  it('refuses the certificate without the CA file', async () => {
    const result = await sendWith(starttlsEnv({ DREFYN_SMTP_CA_FILE: undefined }), 'tls:no-ca');
    expect(result).toEqual(TLS_FAILED);
  });

  it('refuses a certificate for another name', async () => {
    const result = await sendWith(
      starttlsEnv({ DREFYN_SMTP_TLS_SERVERNAME: 'other.drefyn.test' }),
      'tls:wrong-name',
    );
    expect(result).toEqual(TLS_FAILED);
  });
});

describe('implicit TLS', () => {
  it('delivers on implicit TLS', async () => {
    expect((await sendWith(implicitEnv(), 'tls:implicit')).ok).toBe(true);
  });

  it('delivers with a TLS 1.3 floor', async () => {
    const result = await sendWith(
      implicitEnv({ DREFYN_SMTP_TLS_MIN_VERSION: 'TLSv1.3' }),
      'tls:implicit-13',
    );
    expect(result.ok).toBe(true);
  });

  it('refuses a plaintext server instead of falling back', async () => {
    const before = await plainInbox.count();
    const result = await sendWith(
      { DREFYN_SMTP_PORT: String(MAILPIT.plain.smtp), DREFYN_SMTP_TLS: 'implicit' },
      'tls:implicit-on-plain',
    );
    expect(result).toEqual(TLS_FAILED);
    expect(await plainInbox.count()).toBe(before);
  });
});

describe('a self signed certificate', () => {
  const env = (patch: Record<string, string | undefined> = {}) => ({
    DREFYN_SMTP_PORT: String(MAILPIT.selfsigned.smtp),
    DREFYN_SMTP_TLS: 'starttls',
    ...patch,
  });

  it('is refused', async () => {
    expect(await sendWith(env(), 'tls:self')).toEqual(TLS_FAILED);
  });

  it('is accepted once DREFYN_SMTP_CA_FILE names it', async () => {
    const result = await sendWith(
      env({ DREFYN_SMTP_CA_FILE: certFile('self.pem') }),
      'tls:self-ca',
    );
    expect(result.ok).toBe(true);
  });
});

describe('a loopback server with a bad certificate', () => {
  let server: ServerRecord;
  beforeAll(async () => {
    server = await smtpServer({}, { cert: readCert('self.pem'), key: readCert('self.key') });
  });
  afterAll(async () => {
    await server.close();
  });

  it('is refused once, never retried and never sent a command', async () => {
    const result = await sendWith(
      { DREFYN_SMTP_PORT: String(server.port), DREFYN_SMTP_TLS: 'implicit' },
      'tls:bad-cert',
    );
    expect(result).toEqual(TLS_FAILED);
    expect(server.connections).toBe(1);
    expect(server.commands.flat()).toEqual([]);
  });
});

describe('plaintext', () => {
  it('is refused without the opt in', () => {
    const refused = parseEmailConfig({
      DREFYN_EMAIL_TRANSPORT: 'smtp',
      DREFYN_EMAIL_FROM: FROM,
      DREFYN_SMTP_HOST: '127.0.0.1',
      DREFYN_SMTP_PORT: String(MAILPIT.plain.smtp),
      DREFYN_SMTP_TLS: 'none',
    });
    expect(!refused.ok && refused.error.key).toBe('DREFYN_SMTP_ALLOW_PLAINTEXT');
  });

  it('delivers with the opt in and warns once at startup', async () => {
    const cfg = config(plainEnv(MAILPIT.plain.smtp));
    const rec = recorder();
    logEmailConfig({ ok: true, value: cfg }, rec.logger);
    expect(rec.lines.filter((l) => l.event === 'email.plaintext_smtp')).toHaveLength(1);
    const result = await sendWith(plainEnv(MAILPIT.plain.smtp), 'tls:plain');
    expect(result.ok).toBe(true);
  });
});

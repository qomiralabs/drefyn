import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createMailer,
  parseEmailConfig,
  type EmailConfig,
  type Mailer,
  type MailTransport,
} from '../../src/index.ts';
import { ORIGIN, recorder } from '../support.ts';

// scripts/email-integration.sh starts four Mailpit containers on these loopback ports and
// writes the certificates and the AUTH password to the folder it passes here.
export const MAILPIT = {
  // No TLS at all, for the plaintext opt in and the "no STARTTLS offered" refusal.
  plain: { smtp: 53025, api: 53080 },
  // A certificate from the test CA, STARTTLS required, AUTH with the generated password.
  starttls: { smtp: 53587, api: 53081 },
  // The same certificate on implicit TLS, AUTH with the generated password.
  implicit: { smtp: 53465, api: 53082 },
  // A self signed certificate, STARTTLS required, no AUTH.
  selfsigned: { smtp: 53588, api: 53083 },
} as const;

function certsDir(): string {
  const dir = process.env['DREFYN_EMAIL_IT_CERTS'];
  if (dir === undefined || dir === '') {
    throw new Error('DREFYN_EMAIL_IT_CERTS is unset; run bash scripts/email-integration.sh');
  }
  return dir;
}

export const certFile = (name: 'ca.pem' | 'self.pem' | 'self.key') => join(certsDir(), name);
export const readCert = (name: 'ca.pem' | 'self.pem' | 'self.key') =>
  readFileSync(certFile(name), 'utf8');

export function credentials(): { readonly user: string; readonly password: string } {
  const [user, password] = readFileSync(join(certsDir(), 'auth.txt'), 'utf8').trim().split(':');
  if (user === undefined || password === undefined) throw new Error('auth.txt is malformed');
  return { user, password };
}

export const FROM = 'mail@drefyn.test';
export const TO = 'person@example.com';

// Short limits, so failure tests finish fast and still exercise each timeout.
export const FAST = {
  DREFYN_SMTP_CONNECT_TIMEOUT_MS: '1000',
  DREFYN_SMTP_GREETING_TIMEOUT_MS: '1000',
  DREFYN_SMTP_SOCKET_TIMEOUT_MS: '1000',
  DREFYN_SMTP_SEND_DEADLINE_MS: '4000',
} as const;

export function config(patch: Record<string, string | undefined>): EmailConfig {
  const result = parseEmailConfig({
    DREFYN_EMAIL_TRANSPORT: 'smtp',
    DREFYN_EMAIL_FROM: FROM,
    DREFYN_EMAIL_FROM_NAME: 'Drefyn',
    DREFYN_SMTP_HOST: '127.0.0.1',
    DREFYN_SMTP_TLS_SERVERNAME: 'localhost',
    DREFYN_SMTP_EHLO_NAME: 'drefyn.test',
    ...patch,
  });
  if (!result.ok) throw new Error(`test config refused: ${result.error.key}`);
  return result.value;
}

export const implicitEnv = (patch: Record<string, string | undefined> = {}) => ({
  DREFYN_SMTP_PORT: String(MAILPIT.implicit.smtp),
  DREFYN_SMTP_TLS: 'implicit',
  DREFYN_SMTP_CA_FILE: certFile('ca.pem'),
  DREFYN_SMTP_USER: credentials().user,
  DREFYN_SMTP_PASSWORD: credentials().password,
  ...patch,
});

export const plainEnv = (port: number, patch: Record<string, string | undefined> = {}) => ({
  DREFYN_SMTP_PORT: String(port),
  DREFYN_SMTP_TLS: 'none',
  DREFYN_SMTP_ALLOW_PLAINTEXT: 'true',
  ...patch,
});

export interface Harness {
  readonly mailer: Mailer;
  readonly rec: ReturnType<typeof recorder>;
}

// A mailer exactly as the app builds it: no transport passed, so the SMTP transport comes
// from config. A transport is passed only by tests that wrap it to watch it.
export function harness(cfg: EmailConfig, transport?: MailTransport): Harness {
  const rec = recorder();
  const mailer = createMailer(cfg, {
    linkOrigin: ORIGIN,
    logger: rec.logger,
    metrics: rec.metrics,
    ...(transport === undefined ? {} : { transport }),
  });
  return { mailer, rec };
}

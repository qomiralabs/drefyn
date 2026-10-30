import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMailer,
  logEmailConfig,
  parseEmailConfig,
  type MailMessage,
  type TransportError,
} from '../src/index.ts';
import { createTestTransport } from '../src/testing.ts';
import { AT, ORIGIN, TENANT, recorder, smtpConfig, smtpEnv } from './support.ts';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: 2_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

// Values that must never reach a log line or a metric, each distinct enough to search for.
const ADDRESS = 'sentinel.person@sentinel-domain.example';
const DOMAIN = 'sentinel-domain';
const CODE = '97531864';
const PATH = '/sentinel-path-xyz';
const KEY = 'code:sentinel-key-abc';
const ORG = 'SentinelOrgName';
const INVITER = 'SentinelInviter';
const DEVICE = 'SentinelDevice';
const PASSWORD = 'sentinel-password-123';
const SECRETS = [ADDRESS, DOMAIN, CODE, PATH, KEY, ORG, INVITER, DEVICE, PASSWORD, 'sentinel'];

const SEND_FIELDS = new Set([
  'template',
  'purpose',
  'noticeKind',
  'outcome',
  'errorCode',
  'smtpReplyClass',
  'attempts',
  'durationMs',
  'transport',
  'organizationId',
  'projectId',
]);
const METRIC_LABELS = new Set(['template', 'purpose', 'outcome']);

const messages: readonly MailMessage[] = [
  {
    template: 'sign_in_code',
    purpose: 'link_identity',
    code: CODE,
    link: new URL(PATH, ORIGIN),
    expiresInMinutes: 10,
    linking: { provider: 'github', account: ADDRESS },
  },
  {
    template: 'invitation',
    organizationName: ORG,
    inviterName: INVITER,
    link: new URL(PATH, ORIGIN),
    expiresAt: AT,
  },
  {
    template: 'security_notice',
    notice: {
      kind: 'new_device_sign_in',
      at: AT,
      device: DEVICE,
      sessionsLink: new URL(PATH, ORIGIN),
    },
  },
  // Refused input still logs, and must not echo what was refused.
  {
    template: 'invitation',
    organizationName: `${ORG}\n`,
    inviterName: INVITER,
    link: new URL(PATH, ORIGIN),
    expiresAt: AT,
  },
  {
    template: 'sign_in_code',
    purpose: 'sign_in',
    code: CODE,
    link: new URL(`https://${DOMAIN}.test${PATH}`),
    expiresInMinutes: 5,
  },
];

const failures: readonly [TransportError['code'], TransportError['phase']][] = [
  ['email.rejected', 'envelope'],
  ['email.deferred', 'envelope'],
  ['email.unknown_outcome', 'after_data'],
  ['email.auth_failed', 'auth'],
];

describe('logs and metrics', () => {
  it('carry only the fixed fields, never an address, domain, code, link, name or key', async () => {
    const transport = createTestTransport();
    const { logger, metrics, lines, calls } = recorder();
    const mailer = createMailer(
      smtpConfig({
        DREFYN_EMAIL_FROM: `mail@${DOMAIN}.example`,
        DREFYN_EMAIL_IDEMPOTENCY_HEADER: 'X-Key',
      }),
      { linkOrigin: ORIGIN, logger, metrics, transport, clock: () => Date.now() },
    );

    for (const message of messages) {
      await mailer.send(ADDRESS, message, { idempotencyKey: KEY, tenant: TENANT });
    }
    for (const [code, phase] of failures) {
      transport.failNext(code, phase);
      transport.failNext(code, phase);
      const pending = mailer.send(ADDRESS, messages[0] as MailMessage, { idempotencyKey: KEY });
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(1500);
      await pending;
    }
    await mailer.send(`bad ${ADDRESS}`, messages[0] as MailMessage, { idempotencyKey: KEY });
    transport.hangNext();
    const hung = mailer.send(ADDRESS, messages[1] as MailMessage, { idempotencyKey: KEY });
    for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
    await mailer.drain(0).then(() => vi.advanceTimersByTimeAsync(15_000));
    await hung;

    const sends = lines.filter((l) => l.event === 'email.send');
    expect(sends.length).toBeGreaterThanOrEqual(messages.length + failures.length + 2);
    const outcomes = new Set(sends.map((l) => l.fields['outcome']));
    expect([...outcomes].sort()).toEqual(
      ['failed', 'input_invalid', 'sent', 'timeout', 'unknown_outcome'].sort(),
    );
    for (const line of sends) {
      for (const key of Object.keys(line.fields)) expect(SEND_FIELDS.has(key), key).toBe(true);
    }
    expect(sends.some((l) => l.fields['smtpReplyClass'] === 5)).toBe(true);
    for (const call of calls) {
      for (const key of Object.keys(call.labels)) expect(METRIC_LABELS.has(key), key).toBe(true);
    }

    const everything = inspect({ lines, calls }, { depth: 20 });
    for (const secret of SECRETS) expect(everything).not.toContain(secret);
    expect(everything).not.toContain(PATH);
  });

  it('log startup events with the key or mode only', () => {
    const run = (env: Record<string, string | undefined>) => {
      const { logger, lines } = recorder();
      logEmailConfig(parseEmailConfig(env), logger);
      return lines;
    };
    expect(run({})).toEqual([{ level: 'warn', event: 'email.no_transport', fields: {} }]);
    expect(run(smtpEnv())).toEqual([
      {
        level: 'info',
        event: 'email.transport_configured',
        fields: { kind: 'smtp', tls: 'implicit', port: 465 },
      },
    ]);
    expect(run(smtpEnv({ DREFYN_SMTP_TLS: 'none', DREFYN_SMTP_ALLOW_PLAINTEXT: 'true' }))).toEqual([
      {
        level: 'info',
        event: 'email.transport_configured',
        fields: { kind: 'smtp', tls: 'none', port: 1025 },
      },
      { level: 'warn', event: 'email.plaintext_smtp', fields: {} },
    ]);
    const refused = run(
      smtpEnv({
        DREFYN_SMTP_USER: 'relay',
        DREFYN_SMTP_PASSWORD: PASSWORD,
        DREFYN_SMTP_PORT: PASSWORD,
      }),
    );
    expect(refused).toEqual([
      { level: 'error', event: 'email.config_invalid', fields: { key: 'DREFYN_SMTP_PORT' } },
    ]);
    const withSecrets = run(
      smtpEnv({
        DREFYN_SMTP_USER: 'sentinel-user',
        DREFYN_SMTP_PASSWORD: PASSWORD,
        DREFYN_SMTP_HOST: `${DOMAIN}.example`,
      }),
    );
    expect(inspect(withSecrets, { depth: 10 })).not.toMatch(/sentinel/);
  });
});

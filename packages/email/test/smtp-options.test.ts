import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseEmailConfig, type SmtpConfig } from '../src/index.ts';
import { connectionOptions } from '../src/smtp/options.ts';
import { runs, smtpConfig } from './support.ts';

const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';

function smtp(patch: Record<string, string | undefined> = {}): SmtpConfig {
  const config = smtpConfig(patch);
  if (config.kind !== 'smtp') throw new Error('expected smtp config');
  return config.smtp;
}

describe('connection options', () => {
  it('uses implicit TLS on 465 and never STARTTLS on top of it', () => {
    const options = connectionOptions(smtp());
    expect(options).toMatchObject({
      host: 'smtp.drefyn.test',
      port: 465,
      secure: true,
      requireTLS: false,
      ignoreTLS: false,
      opportunisticTLS: false,
    });
  });

  it('requires STARTTLS on any other port', () => {
    expect(connectionOptions(smtp({ DREFYN_SMTP_PORT: '587' }))).toMatchObject({
      port: 587,
      secure: false,
      requireTLS: true,
      ignoreTLS: false,
      opportunisticTLS: false,
    });
    expect(
      connectionOptions(smtp({ DREFYN_SMTP_PORT: '465', DREFYN_SMTP_TLS: 'starttls' })),
    ).toMatchObject({ port: 465, secure: false, requireTLS: true });
  });

  it('speaks plaintext only for the opt in, and then ignores an offered STARTTLS', () => {
    const options = connectionOptions(
      smtp({ DREFYN_SMTP_TLS: 'none', DREFYN_SMTP_ALLOW_PLAINTEXT: 'true' }),
    );
    expect(options).toMatchObject({
      port: 1025,
      secure: false,
      requireTLS: false,
      ignoreTLS: true,
      opportunisticTLS: false,
    });
  });

  it('always checks the certificate, with a TLS 1.2 floor by default', () => {
    for (const tls of ['implicit', 'starttls', 'none'] as const) {
      const options = connectionOptions(
        smtp({
          DREFYN_SMTP_TLS: tls,
          ...(tls === 'none' ? { DREFYN_SMTP_ALLOW_PLAINTEXT: 'true' } : {}),
        }),
      );
      expect(options.tls.rejectUnauthorized).toBe(true);
      expect(options.tls.minVersion).toBe('TLSv1.2');
    }
    expect(connectionOptions(smtp({ DREFYN_SMTP_TLS_MIN_VERSION: 'TLSv1.3' })).tls.minVersion).toBe(
      'TLSv1.3',
    );
  });

  it('adds a private CA and a server name for the certificate check', () => {
    const config = parseEmailConfig(
      {
        DREFYN_EMAIL_TRANSPORT: 'smtp',
        DREFYN_EMAIL_FROM: 'mail@drefyn.test',
        DREFYN_SMTP_HOST: '10.0.0.7',
        DREFYN_SMTP_CA_FILE: '/run/ca.pem',
        DREFYN_SMTP_TLS_SERVERNAME: 'relay.internal.test',
      },
      () => PEM,
    );
    if (!config.ok || config.value.kind !== 'smtp') throw new Error('expected smtp config');
    const options = connectionOptions(config.value.smtp);
    expect(options.host).toBe('10.0.0.7');
    expect(options.servername).toBe('relay.internal.test');
    expect(options.tls.servername).toBe('relay.internal.test');
    expect(options.tls.ca).toBe(PEM);
  });

  it('checks the host name itself when no server name is set', () => {
    const options = connectionOptions(smtp());
    expect(options.servername).toBe('smtp.drefyn.test');
    expect(options.tls.servername).toBe('smtp.drefyn.test');
    expect('ca' in options.tls).toBe(false);
  });

  it('leaves an IP literal host to be checked against the certificate as an address', () => {
    const options = connectionOptions(smtp({ DREFYN_SMTP_HOST: '127.0.0.1' }));
    expect('servername' in options).toBe(false);
    expect('servername' in options.tls).toBe(false);
  });

  it('passes the timeouts, the EHLO name, and no logger or debug output', () => {
    const options = connectionOptions(
      smtp({
        DREFYN_SMTP_CONNECT_TIMEOUT_MS: '3000',
        DREFYN_SMTP_GREETING_TIMEOUT_MS: '4000',
        DREFYN_SMTP_SOCKET_TIMEOUT_MS: '6000',
        DREFYN_SMTP_EHLO_NAME: 'mx.drefyn.test',
      }),
    );
    expect(options).toMatchObject({
      name: 'mx.drefyn.test',
      connectionTimeout: 3000,
      dnsTimeout: 3000,
      greetingTimeout: 4000,
      socketTimeout: 6000,
      logger: false,
      debug: false,
      transactionLog: false,
    });
  });

  it('never carries the password', () => {
    const options = connectionOptions(
      smtp({ DREFYN_SMTP_USER: 'relay', DREFYN_SMTP_PASSWORD: 'hunter2-secret' }),
    );
    expect(JSON.stringify(options)).not.toContain('hunter2-secret');
    expect('auth' in options).toBe(false);
  });

  it('checks certificates for every config the parser accepts', () => {
    const env = fc.record(
      {
        DREFYN_SMTP_TLS: fc.constantFrom('implicit', 'starttls', 'none'),
        DREFYN_SMTP_PORT: fc.integer({ min: 1, max: 65_535 }).map(String),
        DREFYN_SMTP_HOST: fc.constantFrom('smtp.drefyn.test', '127.0.0.1', '::1'),
        DREFYN_SMTP_TLS_MIN_VERSION: fc.constantFrom('TLSv1.2', 'TLSv1.3'),
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(env, (patch) => {
        const parsed = parseEmailConfig({
          DREFYN_EMAIL_TRANSPORT: 'smtp',
          DREFYN_EMAIL_FROM: 'mail@drefyn.test',
          DREFYN_SMTP_HOST: 'smtp.drefyn.test',
          DREFYN_SMTP_ALLOW_PLAINTEXT: 'true',
          ...patch,
        });
        if (!parsed.ok || parsed.value.kind !== 'smtp') return;
        const options = connectionOptions(parsed.value.smtp);
        expect(options.tls.rejectUnauthorized).toBe(true);
        expect(options.opportunisticTLS).toBe(false);
        // Encryption is on unless the operator opted out of it.
        const encrypted = options.secure || options.requireTLS;
        expect(encrypted).toBe(parsed.value.smtp.tls !== 'none');
      }),
      runs,
    );
  });
});

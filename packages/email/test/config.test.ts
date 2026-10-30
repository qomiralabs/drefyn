import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { EMAIL_CONFIG_KEYS, parseEmailConfig, type EmailConfigKey } from '../src/index.ts';
import { smtpEnv } from './support.ts';

type Env = Record<string, string | undefined>;

const PASSWORD = 'hunter2-sentinel-password';
const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';

const files: Record<string, string> = {
  '/run/secrets/smtp': `${PASSWORD}\n`,
  '/etc/ca.pem': PEM,
  '/etc/not-pem.txt': 'just text',
};
const readFile = (path: string): string => {
  const text = files[path];
  if (text === undefined) throw new Error(`ENOENT: ${path}`);
  return text;
};

function parse(patch: Env) {
  return parseEmailConfig(smtpEnv(patch), readFile);
}

function smtp(patch: Env = {}) {
  const result = parse(patch);
  if (!result.ok) throw new Error(`refused ${result.error.key}: ${result.error.reason}`);
  if (result.value.kind !== 'smtp') throw new Error('expected smtp');
  return result.value;
}

function refuses(patch: Env, key: EmailConfigKey) {
  const result = parse(patch);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe('email.config_invalid');
  expect(result.error.key).toBe(key);
  // Whatever the operator typed must not come back, since it may be a pasted secret.
  const text = JSON.stringify(result.error) + inspect(result.error);
  for (const value of Object.values(patch)) {
    if (value !== undefined && value.length > 8) expect(text).not.toContain(value);
  }
  expect(text).not.toContain(PASSWORD);
  return result.error;
}

describe('parseEmailConfig with no transport', () => {
  it.each([[{}], [{ DREFYN_EMAIL_TRANSPORT: 'none' }], [{ DREFYN_EMAIL_TRANSPORT: '' }]])(
    'gives kind none for %j',
    (env) => {
      const result = parseEmailConfig(env);
      expect(result).toEqual({ ok: true, value: { kind: 'none' } });
      if (result.ok) expect(Object.isFrozen(result.value)).toBe(true);
    },
  );

  it('ignores SMTP keys when the transport is none', () => {
    expect(parseEmailConfig({ DREFYN_EMAIL_TRANSPORT: 'none', DREFYN_SMTP_PORT: 'x' }).ok).toBe(
      true,
    );
  });

  it('refuses an unknown transport', () => {
    refuses({ DREFYN_EMAIL_TRANSPORT: 'sendmail' }, 'DREFYN_EMAIL_TRANSPORT');
  });
});

describe('parseEmailConfig defaults', () => {
  it('fills every default from the config table', () => {
    const config = smtp();
    expect(config.sender).toEqual({ from: 'mail@drefyn.test', fromName: 'Drefyn' });
    expect(config.idempotencyHeader).toBeUndefined();
    expect(config.limits).toEqual({ maxConcurrent: 4, queueMax: 100 });
    expect(config.smtp.host).toBe('smtp.drefyn.test');
    expect(config.smtp.port).toBe(465);
    expect(config.smtp.tls).toBe('implicit');
    expect(config.smtp.auth).toBeUndefined();
    expect(config.smtp.ca).toBeUndefined();
    expect(config.smtp.servername).toBeUndefined();
    expect(config.smtp.minTlsVersion).toBe('TLSv1.2');
    expect(config.smtp.ehloName).toBe('drefyn.test');
    expect(config.smtp.timeouts).toEqual({
      connectMs: 5000,
      greetingMs: 5000,
      socketMs: 10_000,
      deadlineMs: 15_000,
    });
  });

  it('freezes the whole config', () => {
    const config = smtp();
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.smtp)).toBe(true);
    expect(Object.isFrozen(config.smtp.timeouts)).toBe(true);
    expect(Object.isFrozen(config.sender)).toBe(true);
    expect(Object.isFrozen(config.limits)).toBe(true);
  });

  it('picks the port from the TLS mode and the mode from the port', () => {
    expect(smtp({ DREFYN_SMTP_TLS: 'starttls' }).smtp.port).toBe(587);
    expect(smtp({ DREFYN_SMTP_TLS: 'implicit' }).smtp.port).toBe(465);
    expect(smtp({ DREFYN_SMTP_TLS: 'none', DREFYN_SMTP_ALLOW_PLAINTEXT: 'true' }).smtp.port).toBe(
      1025,
    );
    expect(smtp({ DREFYN_SMTP_PORT: '587' }).smtp.tls).toBe('starttls');
    expect(smtp({ DREFYN_SMTP_PORT: '2465' }).smtp.tls).toBe('starttls');
    expect(smtp({ DREFYN_SMTP_PORT: '465' }).smtp.tls).toBe('implicit');
    expect(smtp({ DREFYN_SMTP_PORT: '2465', DREFYN_SMTP_TLS: 'implicit' }).smtp.port).toBe(2465);
  });

  it('reads every optional key', () => {
    const config = smtp({
      DREFYN_EMAIL_FROM: 'Mail@Drefyn.TEST',
      DREFYN_EMAIL_FROM_NAME: 'Drefyn Auth',
      DREFYN_EMAIL_REPLY_TO: 'help@drefyn.test',
      DREFYN_EMAIL_IDEMPOTENCY_HEADER: 'Resend-Idempotency-Key',
      DREFYN_EMAIL_QUEUE_MAX: '1000',
      DREFYN_SMTP_HOST: '10.0.0.5',
      DREFYN_SMTP_PORT: '2587',
      DREFYN_SMTP_TLS: 'starttls',
      DREFYN_SMTP_USER: 'relay',
      DREFYN_SMTP_PASSWORD: PASSWORD,
      DREFYN_SMTP_CA_FILE: '/etc/ca.pem',
      DREFYN_SMTP_TLS_SERVERNAME: 'relay.internal',
      DREFYN_SMTP_TLS_MIN_VERSION: 'TLSv1.3',
      DREFYN_SMTP_EHLO_NAME: 'app.drefyn.test',
      DREFYN_SMTP_CONNECT_TIMEOUT_MS: '1000',
      DREFYN_SMTP_GREETING_TIMEOUT_MS: '30000',
      DREFYN_SMTP_SOCKET_TIMEOUT_MS: '60000',
      DREFYN_SMTP_SEND_DEADLINE_MS: '2000',
      DREFYN_SMTP_MAX_CONCURRENT: '32',
    });
    expect(config.sender).toEqual({
      from: 'mail@drefyn.test',
      fromName: 'Drefyn Auth',
      replyTo: 'help@drefyn.test',
    });
    expect(config.idempotencyHeader).toBe('Resend-Idempotency-Key');
    expect(config.limits).toEqual({ maxConcurrent: 32, queueMax: 1000 });
    expect(config.smtp.host).toBe('10.0.0.5');
    expect(config.smtp.port).toBe(2587);
    expect(config.smtp.auth?.user).toBe('relay');
    expect(config.smtp.auth?.password.reveal()).toBe(PASSWORD);
    expect(config.smtp.ca).toBe(PEM);
    expect(config.smtp.servername).toBe('relay.internal');
    expect(config.smtp.minTlsVersion).toBe('TLSv1.3');
    expect(config.smtp.ehloName).toBe('app.drefyn.test');
    expect(config.smtp.timeouts).toEqual({
      connectMs: 1000,
      greetingMs: 30_000,
      socketMs: 60_000,
      deadlineMs: 2000,
    });
  });

  it('reads the password from a file and drops its trailing newline', () => {
    const config = smtp({
      DREFYN_SMTP_USER: 'relay',
      DREFYN_SMTP_PASSWORD_FILE: '/run/secrets/smtp',
    });
    expect(config.smtp.auth?.password.reveal()).toBe(PASSWORD);
  });

  it('accepts IPv6 literal hosts', () => {
    expect(smtp({ DREFYN_SMTP_HOST: '::1' }).smtp.host).toBe('::1');
  });

  it('allows plaintext with the opt in and no credentials', () => {
    const config = smtp({ DREFYN_SMTP_TLS: 'none', DREFYN_SMTP_ALLOW_PLAINTEXT: 'true' });
    expect(config.smtp.tls).toBe('none');
  });

  it('never shows the password when the config is printed or serialised', () => {
    const config = smtp({ DREFYN_SMTP_USER: 'relay', DREFYN_SMTP_PASSWORD: PASSWORD });
    expect(JSON.stringify(config)).not.toContain(PASSWORD);
    expect(inspect(config, { depth: 10 })).not.toContain(PASSWORD);
    expect(String(config.smtp.auth?.password)).not.toContain(PASSWORD);
  });

  it('lists every key it reads', () => {
    expect([...EMAIL_CONFIG_KEYS].sort()).toEqual(
      [
        'DREFYN_EMAIL_TRANSPORT',
        'DREFYN_EMAIL_FROM',
        'DREFYN_EMAIL_FROM_NAME',
        'DREFYN_EMAIL_REPLY_TO',
        'DREFYN_EMAIL_IDEMPOTENCY_HEADER',
        'DREFYN_EMAIL_QUEUE_MAX',
        'DREFYN_SMTP_HOST',
        'DREFYN_SMTP_PORT',
        'DREFYN_SMTP_TLS',
        'DREFYN_SMTP_ALLOW_PLAINTEXT',
        'DREFYN_SMTP_USER',
        'DREFYN_SMTP_PASSWORD',
        'DREFYN_SMTP_PASSWORD_FILE',
        'DREFYN_SMTP_CA_FILE',
        'DREFYN_SMTP_TLS_SERVERNAME',
        'DREFYN_SMTP_TLS_MIN_VERSION',
        'DREFYN_SMTP_EHLO_NAME',
        'DREFYN_SMTP_CONNECT_TIMEOUT_MS',
        'DREFYN_SMTP_GREETING_TIMEOUT_MS',
        'DREFYN_SMTP_SOCKET_TIMEOUT_MS',
        'DREFYN_SMTP_SEND_DEADLINE_MS',
        'DREFYN_SMTP_MAX_CONCURRENT',
      ].sort(),
    );
  });
});

describe('parseEmailConfig refusals', () => {
  it('refuses missing required keys', () => {
    refuses({ DREFYN_EMAIL_FROM: undefined }, 'DREFYN_EMAIL_FROM');
    refuses({ DREFYN_SMTP_HOST: undefined }, 'DREFYN_SMTP_HOST');
  });

  it('refuses addresses that fail the address rule', () => {
    refuses({ DREFYN_EMAIL_FROM: 'not an address' }, 'DREFYN_EMAIL_FROM');
    refuses({ DREFYN_EMAIL_REPLY_TO: 'help@@drefyn.test' }, 'DREFYN_EMAIL_REPLY_TO');
  });

  it.each([
    ['DREFYN_EMAIL_QUEUE_MAX', ['0', '1001', 'ten', '1e2', ' 10', '0x10', '-1']],
    ['DREFYN_SMTP_PORT', ['0', '65536', 'smtp', '25.5']],
    ['DREFYN_SMTP_CONNECT_TIMEOUT_MS', ['999', '30001', 'Infinity']],
    ['DREFYN_SMTP_GREETING_TIMEOUT_MS', ['999', '30001']],
    ['DREFYN_SMTP_SOCKET_TIMEOUT_MS', ['999', '60001']],
    ['DREFYN_SMTP_SEND_DEADLINE_MS', ['1999', '60001']],
    ['DREFYN_SMTP_MAX_CONCURRENT', ['0', '33']],
  ] as const)('refuses an unparsable or out of range %s', (key, values) => {
    for (const value of values) refuses({ [key]: value }, key);
  });

  it.each([
    ['DREFYN_SMTP_TLS', 'ssl'],
    ['DREFYN_SMTP_TLS_MIN_VERSION', 'TLSv1.1'],
    ['DREFYN_SMTP_ALLOW_PLAINTEXT', 'yes'],
  ] as const)('refuses %s=%s', (key, value) => {
    refuses({ [key]: value }, key);
  });

  it('refuses plaintext without the opt in', () => {
    refuses({ DREFYN_SMTP_TLS: 'none' }, 'DREFYN_SMTP_ALLOW_PLAINTEXT');
    refuses(
      { DREFYN_SMTP_TLS: 'none', DREFYN_SMTP_ALLOW_PLAINTEXT: 'false' },
      'DREFYN_SMTP_ALLOW_PLAINTEXT',
    );
  });

  it('refuses plaintext with credentials', () => {
    refuses(
      {
        DREFYN_SMTP_TLS: 'none',
        DREFYN_SMTP_ALLOW_PLAINTEXT: 'true',
        DREFYN_SMTP_USER: 'relay',
        DREFYN_SMTP_PASSWORD: PASSWORD,
      },
      'DREFYN_SMTP_TLS',
    );
  });

  it('refuses half a credential pair', () => {
    refuses({ DREFYN_SMTP_USER: 'relay' }, 'DREFYN_SMTP_PASSWORD');
    refuses({ DREFYN_SMTP_PASSWORD: PASSWORD }, 'DREFYN_SMTP_USER');
    refuses({ DREFYN_SMTP_PASSWORD_FILE: '/run/secrets/smtp' }, 'DREFYN_SMTP_USER');
  });

  it('refuses both password forms', () => {
    refuses(
      {
        DREFYN_SMTP_USER: 'relay',
        DREFYN_SMTP_PASSWORD: PASSWORD,
        DREFYN_SMTP_PASSWORD_FILE: '/run/secrets/smtp',
      },
      'DREFYN_SMTP_PASSWORD_FILE',
    );
  });

  it('refuses an unreadable or empty password file', () => {
    refuses(
      { DREFYN_SMTP_USER: 'relay', DREFYN_SMTP_PASSWORD_FILE: '/missing' },
      'DREFYN_SMTP_PASSWORD_FILE',
    );
    files['/run/secrets/empty'] = '\n';
    refuses(
      { DREFYN_SMTP_USER: 'relay', DREFYN_SMTP_PASSWORD_FILE: '/run/secrets/empty' },
      'DREFYN_SMTP_PASSWORD_FILE',
    );
  });

  it('refuses a CA file that cannot be read or holds no certificate', () => {
    refuses({ DREFYN_SMTP_CA_FILE: '/missing.pem' }, 'DREFYN_SMTP_CA_FILE');
    refuses({ DREFYN_SMTP_CA_FILE: '/etc/not-pem.txt' }, 'DREFYN_SMTP_CA_FILE');
  });

  it('refuses a deadline below the connect timeout', () => {
    refuses(
      { DREFYN_SMTP_CONNECT_TIMEOUT_MS: '9000', DREFYN_SMTP_SEND_DEADLINE_MS: '8000' },
      'DREFYN_SMTP_SEND_DEADLINE_MS',
    );
  });

  it('refuses unsafe header values and names', () => {
    refuses({ DREFYN_EMAIL_FROM_NAME: 'Drefyn\r\nBcc: x@evil.test' }, 'DREFYN_EMAIL_FROM_NAME');
    refuses({ DREFYN_EMAIL_FROM_NAME: 'Drefyn\u2028' }, 'DREFYN_EMAIL_FROM_NAME');
    refuses({ DREFYN_EMAIL_FROM_NAME: 'x'.repeat(65) }, 'DREFYN_EMAIL_FROM_NAME');
    refuses({ DREFYN_EMAIL_FROM_NAME: '   ' }, 'DREFYN_EMAIL_FROM_NAME');
    for (const name of [
      'Bad Header',
      'X:Key',
      'X-Key\r\n',
      'Ünïcode',
      'Message-ID',
      'subject',
      'x'.repeat(77),
    ]) {
      refuses({ DREFYN_EMAIL_IDEMPOTENCY_HEADER: name }, 'DREFYN_EMAIL_IDEMPOTENCY_HEADER');
    }
  });

  it('refuses host names that are not host names', () => {
    for (const host of [
      'smtp drefyn.test',
      'smtp.drefyn.test:25',
      'user@smtp.test',
      '-bad.test',
      'a'.repeat(254),
      '1.2.3.4.5x/',
    ]) {
      refuses({ DREFYN_SMTP_HOST: host }, 'DREFYN_SMTP_HOST');
    }
    refuses({ DREFYN_SMTP_EHLO_NAME: 'ehlo name\r\n' }, 'DREFYN_SMTP_EHLO_NAME');
    refuses({ DREFYN_SMTP_TLS_SERVERNAME: '10.0.0.1' }, 'DREFYN_SMTP_TLS_SERVERNAME');
  });

  it('refuses a user name with control characters', () => {
    refuses({ DREFYN_SMTP_USER: 'relay\n', DREFYN_SMTP_PASSWORD: PASSWORD }, 'DREFYN_SMTP_USER');
  });
});

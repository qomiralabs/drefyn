import { describe, expect, it } from 'vitest';
import {
  createMailer,
  type EmailConfig,
  type EmailDeps,
  type MailTransport,
  type Mailer,
  type SendResult,
} from '../src/index.ts';
import { createTestTransport } from '../src/testing.ts';
import { ORIGIN, recorder, signIn, smtpConfig } from './support.ts';

// Whatever a caller or a port does, send hands back a promise that settles. These are
// the ways a hostile or buggy caller can reach code outside the guarded paths.
const TO = 'person@example.com';

const boom = (): never => {
  throw new Error('boom');
};
// Typed as never so it can stand in for any argument.
const trap = (): never =>
  new Proxy({}, { get: boom, has: boom, ownKeys: boom, getOwnPropertyDescriptor: boom }) as never;

type Kind = 'smtp' | 'none';

function mailerOf(kind: Kind, patch: Partial<EmailDeps> = {}): Mailer {
  const { logger, metrics } = recorder();
  const config: EmailConfig = kind === 'smtp' ? smtpConfig() : { kind: 'none' };
  return createMailer(config, {
    linkOrigin: ORIGIN,
    logger,
    metrics,
    transport: createTestTransport(),
    ...patch,
  });
}

// Calls send without letting a synchronous throw escape, so the test sees it as a value.
async function settle(work: () => Promise<SendResult>): Promise<SendResult | 'threw'> {
  let pending: Promise<SendResult>;
  try {
    pending = work();
  } catch {
    return 'threw';
  }
  return pending;
}

function codeOf(result: SendResult | 'threw'): string {
  if (result === 'threw') return 'threw';
  return result.ok ? 'sent' : result.error.code;
}

const throwingTenant = {
  idempotencyKey: 'code:1',
  get tenant(): never {
    return boom();
  },
};

describe.each<[Kind, string]>([
  ['smtp', 'sent'],
  ['none', 'email.not_configured'],
])('the %s mailer always settles', (kind, healthy) => {
  it('when the options throw when read', async () => {
    const mailer = mailerOf(kind);
    const result = await settle(() => mailer.send(TO, signIn(), trap()));
    if (kind === 'smtp') {
      expect(result).toEqual({
        ok: false,
        error: { code: 'email.input_invalid', retryable: false, field: 'idempotencyKey' },
      });
    } else {
      expect(codeOf(result)).toBe(healthy);
    }
  });

  it('when the tenant getter throws', async () => {
    const mailer = mailerOf(kind);
    expect(codeOf(await settle(() => mailer.send(TO, signIn(), throwingTenant)))).toBe(healthy);
  });

  it('when the message throws when read', async () => {
    const mailer = mailerOf(kind);
    const result = await settle(() => mailer.send(TO, trap(), { idempotencyKey: 'code:1' }));
    expect(codeOf(result)).toBe(kind === 'smtp' ? 'email.render_failed' : healthy);
  });

  it('when the clock throws on every call', async () => {
    const mailer = mailerOf(kind, { clock: boom });
    const result = await settle(() => mailer.send(TO, signIn(), { idempotencyKey: 'code:1' }));
    expect(result).not.toBe('threw');
  });

  it('when the clock throws after its first call', async () => {
    let calls = 0;
    const clock = () => {
      calls += 1;
      if (calls > 1) boom();
      return 1;
    };
    const mailer = mailerOf(kind, { clock });
    const result = await settle(() => mailer.send(TO, signIn(), { idempotencyKey: 'code:1' }));
    expect(result).not.toBe('threw');
  });

  it('when the logger and metrics throw on every call', async () => {
    const mailer = mailerOf(kind, {
      logger: { info: boom, warn: boom, error: boom },
      metrics: { counter: boom, histogram: boom, gauge: boom },
    });
    expect(codeOf(await settle(() => mailer.send(TO, signIn(), throwingTenant)))).toBe(healthy);
  });

  it('when reading the idempotency key throws', async () => {
    const mailer = mailerOf(kind);
    const options = {
      get idempotencyKey(): never {
        return boom();
      },
    };
    const result = await settle(() => mailer.send(TO, signIn(), options));
    expect(codeOf(result)).toBe(kind === 'smtp' ? 'email.input_invalid' : healthy);
    if (kind === 'smtp' && result !== 'threw' && !result.ok) {
      expect(result.error.field).toBe('idempotencyKey');
    }
  });
});

describe('the SMTP mailer always settles', () => {
  it('when the transport kind throws when read', async () => {
    const inner = createTestTransport();
    const transport = {
      get kind(): never {
        return boom();
      },
      deliver: inner.deliver.bind(inner),
      close: inner.close.bind(inner),
    } as unknown as MailTransport;
    const mailer = mailerOf('smtp', { transport });
    const result = await settle(() => mailer.send(TO, signIn(), { idempotencyKey: 'code:1' }));
    expect(codeOf(result)).toBe('sent');
    expect(inner.sent).toHaveLength(1);
  });
});

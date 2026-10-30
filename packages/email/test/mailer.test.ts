import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMailer,
  type EmailConfig,
  type Envelope,
  type MailTransport,
  type SendResult,
  type TransportError,
} from '../src/index.ts';
import { createTestTransport, type TestTransport } from '../src/testing.ts';
import { ORIGIN, TENANT, recorder, signIn, smtpConfig } from './support.ts';

// Only timers and Date are faked: React's server renderer schedules its own work with
// setImmediate, which has to keep running for a render to finish.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: 1_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

const TO = 'person@example.com';

async function flush(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !condition(); i++) await flush(1);
  if (!condition()) throw new Error('condition never held');
}

interface Spy {
  readonly transport: MailTransport;
  readonly test: TestTransport;
  readonly deliveries: { envelope: Envelope; signal: AbortSignal }[];
  closed: number;
}

function spyOn(test: TestTransport = createTestTransport()): Spy {
  const spy: Spy = {
    test,
    deliveries: [],
    closed: 0,
    transport: {
      kind: 'test',
      deliver: (envelope, mail, signal) => {
        spy.deliveries.push({ envelope, signal });
        return test.deliver(envelope, mail, signal);
      },
      close: () => {
        spy.closed += 1;
        return test.close();
      },
    },
  };
  return spy;
}

function setup(config: EmailConfig = smtpConfig(), spy: Spy = spyOn()) {
  const rec = recorder();
  const mailer = createMailer(config, {
    linkOrigin: ORIGIN,
    logger: rec.logger,
    metrics: rec.metrics,
    transport: spy.transport,
    clock: () => Date.now(),
  });
  return { mailer, spy, ...rec };
}

const send = (mailer: ReturnType<typeof setup>['mailer'], key = 'code:1') =>
  mailer.send(TO, signIn(), { idempotencyKey: key });

function failed(result: SendResult) {
  if (result.ok) throw new Error('expected a failure');
  return result.error;
}

describe('a mailer with no transport', () => {
  it('reports not configured and refuses every send', async () => {
    const rec = recorder();
    const mailer = createMailer({ kind: 'none' }, { linkOrigin: ORIGIN, ...rec });
    expect(mailer.configured).toBe(false);
    expect(await send(mailer)).toEqual({
      ok: false,
      error: { code: 'email.not_configured', retryable: false },
    });
    expect(await mailer.drain(10)).toEqual({ dropped: 0 });
  });

  it('refuses to start with SMTP config and no transport', () => {
    const rec = recorder();
    expect(() => createMailer(smtpConfig(), { linkOrigin: ORIGIN, ...rec })).toThrow(
      'email transport is required',
    );
  });
});

describe('a successful send', () => {
  it('delivers once and returns the message id', async () => {
    const { mailer, spy } = setup();
    expect(mailer.configured).toBe(true);
    const result = await send(mailer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attempts).toBe(1);
    expect(spy.test.sent).toHaveLength(1);
    expect(spy.test.sent[0]?.messageId).toBe(result.value.messageId);
  });

  it('marks mail as automatic and sets the idempotency header only when configured', async () => {
    const plain = setup();
    await send(plain.mailer, 'code:a');
    expect([...(plain.spy.deliveries[0]?.envelope.headers ?? [])]).toEqual([
      ['Auto-Submitted', 'auto-generated'],
    ]);

    const keyed = setup(smtpConfig({ DREFYN_EMAIL_IDEMPOTENCY_HEADER: 'Resend-Idempotency-Key' }));
    await send(keyed.mailer, 'code:a');
    const envelope = keyed.spy.deliveries[0]?.envelope;
    expect(envelope?.headers.get('Resend-Idempotency-Key')).toBe('code:a');
    expect(envelope?.from).toBe('mail@drefyn.test');
    expect(envelope?.fromName).toBe('Drefyn');
    expect(envelope?.to).toBe(TO);
    expect(envelope?.replyTo).toBeUndefined();
  });

  it('passes the reply to address from config', async () => {
    const { mailer, spy } = setup(smtpConfig({ DREFYN_EMAIL_REPLY_TO: 'help@drefyn.test' }));
    await send(mailer);
    expect(spy.deliveries[0]?.envelope.replyTo).toBe('help@drefyn.test');
  });
});

describe('Message-ID', () => {
  function expected(key: string): string {
    const digest = createHash('sha256').update(key, 'utf8').digest().subarray(0, 20);
    const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
    let bits = '';
    for (const byte of digest) bits += byte.toString(2).padStart(8, '0');
    let out = '';
    for (let i = 0; i < bits.length; i += 5) out += alphabet[parseInt(bits.slice(i, i + 5), 2)];
    return `<${out}@drefyn.test>`;
  }

  it('derives the id from the key and the sender domain', async () => {
    const { mailer } = setup();
    const result = await send(mailer, 'code:0f1e');
    expect(result.ok && result.value.messageId).toBe(expected('code:0f1e'));
    expect(expected('code:0f1e')).toMatch(/^<[a-z2-7]{32}@drefyn\.test>$/);
  });

  it('is the same on a retry and differs for another key', async () => {
    const { mailer, spy } = setup();
    spy.test.failNext('email.connect_failed', 'connect');
    const pending = send(mailer, 'code:retry');
    await until(() => spy.deliveries.length === 1);
    await vi.advanceTimersByTimeAsync(1500);
    const result = await pending;
    expect(result.ok && result.value.attempts).toBe(2);
    expect(spy.deliveries.map((d) => d.envelope.messageId)).toEqual([
      expected('code:retry'),
      expected('code:retry'),
    ]);
    const other = await send(mailer, 'code:other');
    expect(other.ok && other.value.messageId).toBe(expected('code:other'));
    expect(expected('code:other')).not.toBe(expected('code:retry'));
  });
});

describe('retry rules', () => {
  type Case = readonly [TransportError['code'], TransportError['phase'], boolean, string];
  const cases: readonly Case[] = [
    ['email.connect_failed', 'connect', true, 'email.connect_failed'],
    ['email.timeout', 'connect', true, 'email.timeout'],
    ['email.timeout', 'tls', true, 'email.timeout'],
    ['email.timeout', 'auth', true, 'email.timeout'],
    ['email.timeout', 'envelope', true, 'email.timeout'],
    ['email.deferred', 'connect', true, 'email.deferred'],
    ['email.deferred', 'envelope', true, 'email.deferred'],
    ['email.deferred', 'data', false, 'email.deferred'],
    ['email.timeout', 'data', false, 'email.timeout'],
    ['email.timeout', 'after_data', false, 'email.unknown_outcome'],
    ['email.unknown_outcome', 'after_data', false, 'email.unknown_outcome'],
    ['email.connect_failed', 'after_data', false, 'email.unknown_outcome'],
    ['email.rejected', 'envelope', false, 'email.rejected'],
    ['email.rejected', 'data', false, 'email.rejected'],
    ['email.tls_failed', 'tls', false, 'email.tls_failed'],
    ['email.auth_failed', 'auth', false, 'email.auth_failed'],
  ];

  it.each(cases)('%s in %s: retried %s', async (code, phase, retried, finalCode) => {
    const { mailer, spy } = setup();
    spy.test.failNext(code, phase);
    spy.test.failNext(code, phase);
    const pending = send(mailer);
    await until(() => spy.deliveries.length === 1);
    // The jitter never fires before 500 ms.
    await vi.advanceTimersByTimeAsync(499);
    expect(spy.deliveries).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1001);
    const error = failed(await pending);
    expect(spy.deliveries).toHaveLength(retried ? 2 : 1);
    expect(error.code).toBe(finalCode);
  });

  it('succeeds on the retry after one deferral', async () => {
    const { mailer, spy } = setup();
    spy.test.failNext('email.deferred', 'envelope');
    const pending = send(mailer);
    await until(() => spy.deliveries.length === 1);
    await vi.advanceTimersByTimeAsync(1500);
    const result = await pending;
    expect(result.ok && result.value.attempts).toBe(2);
    expect(spy.test.sent).toHaveLength(1);
  });

  it('marks which failures a caller may try again later', async () => {
    const retryable = async (code: TransportError['code'], phase: TransportError['phase']) => {
      const { mailer, spy } = setup();
      spy.test.failNext(code, phase);
      spy.test.failNext(code, phase);
      const pending = send(mailer);
      await until(() => spy.deliveries.length >= 1);
      await vi.advanceTimersByTimeAsync(1500);
      return failed(await pending);
    };
    expect(await retryable('email.deferred', 'envelope')).toEqual({
      code: 'email.deferred',
      retryable: true,
      smtpReplyClass: 4,
    });
    expect(await retryable('email.rejected', 'envelope')).toEqual({
      code: 'email.rejected',
      retryable: false,
      smtpReplyClass: 5,
    });
    expect((await retryable('email.unknown_outcome', 'after_data')).retryable).toBe(false);
    expect((await retryable('email.connect_failed', 'connect')).retryable).toBe(true);
  });
});

describe('deadline', () => {
  it('returns email.timeout at 15 s and aborts the transport', async () => {
    const { mailer, spy } = setup();
    spy.test.hangNext();
    let settled: SendResult | undefined;
    void send(mailer).then((r) => (settled = r));
    await until(() => spy.deliveries.length === 1);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBeUndefined();
    expect(spy.deliveries[0]?.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => settled !== undefined);
    expect(settled).toEqual({ ok: false, error: { code: 'email.timeout', retryable: true } });
    expect(spy.deliveries[0]?.signal.aborted).toBe(true);
  });

  it('counts the retry inside the same deadline', async () => {
    const { mailer, spy } = setup(smtpConfig({ DREFYN_SMTP_SEND_DEADLINE_MS: '5000' }));
    spy.test.failNext('email.connect_failed', 'connect');
    spy.test.hangNext();
    let settled: SendResult | undefined;
    void send(mailer).then((r) => (settled = r));
    await until(() => spy.deliveries.length === 1);
    await vi.advanceTimersByTimeAsync(1500);
    await until(() => spy.deliveries.length === 2);
    await vi.advanceTimersByTimeAsync(3500);
    await until(() => settled !== undefined);
    expect(settled && !settled.ok && settled.error.code).toBe('email.timeout');
    expect(spy.deliveries[1]?.signal.aborted).toBe(true);
  });

  it('returns at the deadline even when the transport ignores the abort', async () => {
    const stuck: MailTransport = {
      kind: 'test',
      deliver: () => new Promise(() => undefined),
      close: () => Promise.resolve(),
    };
    const rec = recorder();
    const mailer = createMailer(smtpConfig(), {
      linkOrigin: ORIGIN,
      ...rec,
      transport: stuck,
      clock: () => Date.now(),
    });
    let settled: SendResult | undefined;
    void send(mailer).then((r) => (settled = r));
    await flush();
    await vi.advanceTimersByTimeAsync(15_000);
    await until(() => settled !== undefined);
    expect(settled && !settled.ok && settled.error.code).toBe('email.timeout');
  });
});

describe('send never throws', () => {
  it.each([
    [
      'throws',
      () => {
        throw new Error('socket exploded');
      },
    ],
    ['rejects', () => Promise.reject(new Error('socket exploded'))],
    ['returns nonsense', () => Promise.resolve({ nope: true })],
  ] as const)('maps a transport that %s to unknown_outcome without a retry', async (_, deliver) => {
    let calls = 0;
    const broken = {
      kind: 'test',
      deliver: () => {
        calls += 1;
        return deliver();
      },
      close: () => Promise.reject(new Error('close failed')),
    } as unknown as MailTransport;
    const rec = recorder();
    const mailer = createMailer(smtpConfig(), {
      linkOrigin: ORIGIN,
      ...rec,
      transport: broken,
      clock: () => Date.now(),
    });
    const result = await send(mailer);
    expect(failed(result).code).toBe('email.unknown_outcome');
    expect(calls).toBe(1);
    await expect(mailer.drain(10)).resolves.toEqual({ dropped: 0 });
  });

  it('resolves for arguments a typed caller could never pass', async () => {
    const { mailer } = setup();
    const odd = mailer.send as unknown as (...args: unknown[]) => Promise<SendResult>;
    expect(failed(await odd()).code).toBe('email.input_invalid');
    expect(failed(await odd(TO, signIn(), null)).field).toBe('idempotencyKey');
    expect(failed(await odd(TO, signIn(), { idempotencyKey: 7 })).field).toBe('idempotencyKey');
    expect(failed(await odd(42, signIn(), { idempotencyKey: 'k' })).field).toBe('to');
    expect(failed(await odd(TO, { template: 'x' }, { idempotencyKey: 'k' })).field).toBe(
      'template',
    );
  });

  it('survives a logger and metrics port that throw', async () => {
    const spy = spyOn();
    const mailer = createMailer(smtpConfig(), {
      linkOrigin: ORIGIN,
      logger: {
        log: () => {
          throw new Error('log down');
        },
      },
      metrics: {
        count: () => {
          throw new Error('metrics down');
        },
        observe: () => {
          throw new Error('metrics down');
        },
        gauge: () => {
          throw new Error('metrics down');
        },
      },
      transport: spy.transport,
      clock: () => Date.now(),
    });
    const result = await send(mailer);
    expect(result.ok).toBe(true);
  });
});

describe('circuit breaker', () => {
  async function failFive(mailer: ReturnType<typeof setup>['mailer'], spy: Spy) {
    for (let i = 0; i < 5; i++) {
      spy.test.failNext('email.tls_failed', 'tls');
      expect(failed(await send(mailer, `code:${i}`)).code).toBe('email.tls_failed');
    }
  }

  it('opens after 5 consecutive transport failures and fails fast for 30 s', async () => {
    const { mailer, spy, calls, lines } = setup();
    await failFive(mailer, spy);
    const before = spy.deliveries.length;
    expect(await send(mailer)).toEqual({
      ok: false,
      error: { code: 'email.unavailable', retryable: true },
    });
    expect(spy.deliveries).toHaveLength(before);
    expect(calls.filter((c) => c.name === 'email_breaker_open_total')).toHaveLength(1);
    expect(lines.some((l) => l.event === 'email.breaker_open')).toBe(true);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(failed(await send(mailer)).code).toBe('email.unavailable');
  });

  it('lets one trial through after 30 s and closes when it succeeds', async () => {
    const { mailer, spy } = setup();
    await failFive(mailer, spy);
    await vi.advanceTimersByTimeAsync(30_000);
    spy.test.hangNext();
    let trial: SendResult | undefined;
    void send(mailer, 'code:trial').then((r) => (trial = r));
    await until(() => spy.deliveries.length === 6);
    // Only the trial may reach the relay while it decides.
    expect(failed(await send(mailer, 'code:during')).code).toBe('email.unavailable');
    await vi.advanceTimersByTimeAsync(15_000);
    await until(() => trial !== undefined);
    expect(trial && !trial.ok && trial.error.code).toBe('email.timeout');
    // The trial failed, so the breaker is open again.
    expect(failed(await send(mailer)).code).toBe('email.unavailable');
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await send(mailer, 'code:ok')).ok).toBe(true);
    expect((await send(mailer, 'code:ok2')).ok).toBe(true);
  });

  it('is not opened by rejections, and a success resets the count', async () => {
    const { mailer, spy } = setup();
    for (let i = 0; i < 4; i++) {
      spy.test.failNext('email.tls_failed', 'tls');
      await send(mailer, `code:${i}`);
    }
    expect((await send(mailer, 'code:ok')).ok).toBe(true);
    for (let i = 0; i < 4; i++) {
      spy.test.failNext('email.tls_failed', 'tls');
      await send(mailer, `code:b${i}`);
    }
    for (let i = 0; i < 6; i++) {
      spy.test.failNext('email.rejected', 'envelope');
      expect(failed(await send(mailer, `code:r${i}`)).code).toBe('email.rejected');
    }
    expect((await send(mailer, 'code:still')).ok).toBe(true);
  });

  it('does not count bad input against the relay', async () => {
    const { mailer } = setup();
    for (let i = 0; i < 10; i++) {
      expect(failed(await mailer.send('bad', signIn(), { idempotencyKey: 'k' })).code).toBe(
        'email.input_invalid',
      );
    }
    expect((await send(mailer)).ok).toBe(true);
  });
});

describe('queue bound', () => {
  it('takes 4 sends at once and 100 waiting, then returns email.overloaded', async () => {
    const { mailer, spy, calls } = setup();
    for (let i = 0; i < 104; i++) spy.test.hangNext();
    const pending = Array.from({ length: 104 }, (_, i) => send(mailer, `code:${i}`));
    expect(await send(mailer, 'code:over')).toEqual({
      ok: false,
      error: { code: 'email.overloaded', retryable: true },
    });
    await until(() => spy.deliveries.length === 4);
    await flush();
    expect(spy.deliveries).toHaveLength(4);
    // The waiting list never grows past its bound, which is what caps memory.
    const depths = calls.filter((c) => c.name === 'email_queue_depth').map((c) => c.value);
    expect(Math.max(...depths)).toBe(100);
    const { dropped } = await Promise.all([mailer.drain(0), vi.advanceTimersByTimeAsync(0)]).then(
      ([d]) => d,
    );
    expect(dropped).toBe(100);
    await vi.advanceTimersByTimeAsync(15_000);
    const results = await Promise.all(pending);
    expect(results.filter((r) => !r.ok && r.error.code === 'email.timeout')).toHaveLength(4);
    expect(results.filter((r) => !r.ok && r.error.code === 'email.unavailable')).toHaveLength(100);
  });

  it('starts the next waiting send when a slot frees', async () => {
    const { mailer, spy } = setup(
      smtpConfig({ DREFYN_SMTP_MAX_CONCURRENT: '1', DREFYN_EMAIL_QUEUE_MAX: '2' }),
    );
    spy.test.hangNext();
    const first = send(mailer, 'code:1');
    const second = send(mailer, 'code:2');
    const third = send(mailer, 'code:3');
    expect(failed(await send(mailer, 'code:4')).code).toBe('email.overloaded');
    await until(() => spy.deliveries.length === 1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(failed(await first).code).toBe('email.timeout');
    expect((await second).ok).toBe(true);
    expect((await third).ok).toBe(true);
    expect((await send(mailer, 'code:5')).ok).toBe(true);
  });
});

describe('drain', () => {
  it('drops waiting sends, waits for the one in flight and refuses new sends', async () => {
    const { mailer, spy, lines, calls } = setup(
      smtpConfig({ DREFYN_SMTP_MAX_CONCURRENT: '1', DREFYN_EMAIL_QUEUE_MAX: '5' }),
    );
    spy.test.hangNext();
    const inFlight = send(mailer, 'code:1');
    const waiting = [send(mailer, 'code:2'), send(mailer, 'code:3')];
    await until(() => spy.deliveries.length === 1);
    let drained: { dropped: number } | undefined;
    void mailer.drain(1000).then((d) => (drained = d));
    for (const w of waiting) expect(failed(await w).code).toBe('email.unavailable');
    expect(failed(await send(mailer, 'code:late')).code).toBe('email.unavailable');
    await flush();
    expect(drained).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    await until(() => drained !== undefined);
    expect(drained).toEqual({ dropped: 2 });
    expect(spy.closed).toBe(1);
    expect(lines.filter((l) => l.event === 'email.dropped_on_shutdown')).toEqual([
      { level: 'warn', event: 'email.dropped_on_shutdown', fields: { dropped: 2 } },
    ]);
    expect(calls.find((c) => c.name === 'email_dropped_on_shutdown_total')?.value).toBe(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(failed(await inFlight).code).toBe('email.timeout');
    expect(await mailer.drain(10)).toEqual({ dropped: 0 });
  });

  it('returns as soon as the sends in flight finish', async () => {
    const { mailer, spy } = setup();
    const sending = send(mailer);
    await until(() => spy.deliveries.length === 1);
    expect(await mailer.drain(60_000)).toEqual({ dropped: 0 });
    expect((await sending).ok).toBe(true);
  });

  it('counts a send that was still rendering as dropped', async () => {
    const { mailer, spy } = setup();
    const rendering = send(mailer);
    const drained = await mailer.drain(0);
    expect(drained).toEqual({ dropped: 1 });
    expect(failed(await rendering).code).toBe('email.unavailable');
    expect(spy.deliveries).toHaveLength(0);
  });
});

describe('tenant context', () => {
  it('logs the organization and project when given, and null when not', async () => {
    const { mailer, lines } = setup();
    await mailer.send(TO, signIn(), { idempotencyKey: 'code:t', tenant: TENANT });
    await send(mailer, 'code:u');
    const sends = lines.filter((l) => l.event === 'email.send');
    expect(sends[0]?.fields).toMatchObject({
      organizationId: TENANT.organizationId,
      projectId: TENANT.projectId,
    });
    expect(sends[1]?.fields).toMatchObject({ organizationId: null, projectId: null });
  });
});

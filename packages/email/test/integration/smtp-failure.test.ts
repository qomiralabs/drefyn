// How each kind of relay failure ends, and that none of them leaks an address, the
// password, the idempotency key or the relay's reply text.
import { afterAll, describe, expect, it } from 'vitest';
import type { EmailConfig, SendResult } from '../../src/index.ts';
import { FIXTURE_MESSAGES } from '../fixtures/messages.ts';
import type { LogLine, MetricCall } from '../support.ts';
import {
  REPLY_SENTINEL,
  closedPort,
  smtpServer,
  stallingServer,
  type Script,
  type ServerRecord,
} from '../support/servers.ts';
import { FAST, FROM, TO, config, credentials, harness, implicitEnv, plainEnv } from './stack.ts';

const message = FIXTURE_MESSAGES[0]?.[1];
if (message === undefined) throw new Error('no fixtures');

const IDEM_MARK = 'idemmarker';

// Everything any failure below produced, checked at the end.
const captured: { results: SendResult[]; lines: LogLine[]; calls: MetricCall[] } = {
  results: [],
  lines: [],
  calls: [],
};
const servers: ServerRecord[] = [];

async function server(script: Script): Promise<ServerRecord> {
  const s = await smtpServer(script);
  servers.push(s);
  return s;
}

let sends = 0;
async function attempt(cfg: EmailConfig): Promise<{ result: SendResult; ms: number }> {
  const { mailer, rec } = harness(cfg);
  if (message === undefined) throw new Error('no fixtures');
  sends += 1;
  const started = performance.now();
  const result = await mailer.send(TO, message, {
    idempotencyKey: `code:${IDEM_MARK}:${String(sends)}`,
  });
  const ms = performance.now() - started;
  await mailer.drain(2000);
  captured.results.push(result);
  captured.lines.push(...rec.lines);
  captured.calls.push(...rec.calls);
  return { result, ms };
}

const failure = (code: string, retryable: boolean, smtpReplyClass?: 4 | 5) => ({
  ok: false,
  error: smtpReplyClass === undefined ? { code, retryable } : { code, retryable, smtpReplyClass },
});

const loggedAttempts = (count: number) =>
  captured.lines.filter((l) => l.event === 'email.send').at(-1)?.fields['attempts'] === count;

afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !condition(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!condition()) throw new Error('condition never held');
}

describe('a stalling relay', () => {
  it('times out within the configured limit', async () => {
    const s = await stallingServer();
    servers.push(s);
    const { result, ms } = await attempt(config(plainEnv(s.port, FAST)));
    expect(result).toEqual(failure('email.timeout', true));
    // Greeting timeout, a jittered pause of at most 1.5 s, the retry's greeting timeout.
    expect(ms).toBeLessThan(4000 + 250);
    expect(s.connections).toBe(2);
    expect(loggedAttempts(2)).toBe(true);
  });

  it('is cut off at the send deadline when that comes first, and the connection is closed', async () => {
    const s = await stallingServer();
    servers.push(s);
    const { result, ms } = await attempt(
      config(
        plainEnv(s.port, {
          DREFYN_SMTP_CONNECT_TIMEOUT_MS: '2000',
          DREFYN_SMTP_GREETING_TIMEOUT_MS: '30000',
          DREFYN_SMTP_SEND_DEADLINE_MS: '2000',
        }),
      ),
    );
    expect(result).toEqual(failure('email.timeout', true));
    expect(ms).toBeGreaterThanOrEqual(1900);
    expect(ms).toBeLessThan(2000 + 500);
    // The relay's side of the close arrives a moment after ours.
    await until(() => s.open === 0);
  });
});

describe('refusals', () => {
  it('maps refused AUTH to auth_failed and does not retry', async () => {
    const { result } = await attempt(
      config(implicitEnv({ ...FAST, DREFYN_SMTP_PASSWORD: `${credentials().password}-wrong` })),
    );
    expect(result).toEqual(failure('email.auth_failed', false, 5));
    expect(loggedAttempts(1)).toBe(true);
  });

  it('maps a 5xx to rejected and does not retry', async () => {
    const s = await server({
      reply: (command) =>
        command.startsWith('RCPT') ? `550 5.1.1 <${TO}> no mailbox ${REPLY_SENTINEL}` : undefined,
    });
    const { result } = await attempt(config(plainEnv(s.port, FAST)));
    expect(result).toEqual(failure('email.rejected', false, 5));
    expect(s.connections).toBe(1);
  });

  it('retries a 4xx once, then answers deferred', async () => {
    const s = await server({
      reply: (command) =>
        command.startsWith('MAIL') ? `451 4.7.1 <${FROM}> later ${REPLY_SENTINEL}` : undefined,
    });
    const { result } = await attempt(config(plainEnv(s.port, FAST)));
    expect(result).toEqual(failure('email.deferred', true, 4));
    expect(s.connections).toBe(2);
    expect(loggedAttempts(2)).toBe(true);
  });

  it('retries a 421 greeting once, then answers deferred', async () => {
    const s = await server({ greeting: () => `421 4.3.2 busy ${REPLY_SENTINEL}` });
    const { result } = await attempt(config(plainEnv(s.port, FAST)));
    expect(result).toEqual(failure('email.deferred', true, 4));
    expect(s.connections).toBe(2);
  });

  it('maps a relay that is not there to connect_failed after one retry', async () => {
    const port = await closedPort();
    const { result } = await attempt(config(plainEnv(port, FAST)));
    expect(result).toEqual(failure('email.connect_failed', true));
    expect(loggedAttempts(2)).toBe(true);
  });
});

describe('after the data', () => {
  it('maps no reply to the final dot to unknown_outcome and does not retry', async () => {
    const s = await server({ afterData: () => 'stall' });
    const { result } = await attempt(config(plainEnv(s.port, FAST)));
    expect(result).toEqual(failure('email.unknown_outcome', false));
    expect(s.messages).toHaveLength(1);
    expect(s.connections).toBe(1);
  });

  it('maps a connection dropped after the final dot to unknown_outcome', async () => {
    const s = await server({ afterData: () => 'drop' });
    const { result } = await attempt(config(plainEnv(s.port, FAST)));
    expect(result).toEqual(failure('email.unknown_outcome', false));
    expect(s.connections).toBe(1);
  });

  it('maps the send deadline after DATA started to unknown_outcome', async () => {
    const s = await server({ afterData: () => 'stall' });
    const { result } = await attempt(
      config(
        plainEnv(s.port, {
          DREFYN_SMTP_CONNECT_TIMEOUT_MS: '2000',
          DREFYN_SMTP_SOCKET_TIMEOUT_MS: '30000',
          DREFYN_SMTP_SEND_DEADLINE_MS: '2000',
        }),
      ),
    );
    expect(result).toEqual(failure('email.unknown_outcome', false));
    expect(s.connections).toBe(1);
    await until(() => s.open === 0);
  });

  it('treats a 5xx read after the final dot as a known rejection', async () => {
    const s = await server({ afterData: () => `554 5.7.1 <${TO}> spam ${REPLY_SENTINEL}` });
    const { result } = await attempt(config(plainEnv(s.port, FAST)));
    expect(result).toEqual(failure('email.rejected', false, 5));
    expect(s.connections).toBe(1);
  });
});

describe('the concurrency slot', () => {
  it('is released only once the timed out connection is closed', async () => {
    const s = await stallingServer();
    servers.push(s);
    const cfg = config(
      plainEnv(s.port, {
        DREFYN_SMTP_CONNECT_TIMEOUT_MS: '2000',
        DREFYN_SMTP_GREETING_TIMEOUT_MS: '30000',
        DREFYN_SMTP_SEND_DEADLINE_MS: '2000',
        DREFYN_SMTP_MAX_CONCURRENT: '1',
      }),
    );
    const { mailer, rec } = harness(cfg);
    const first = mailer.send(TO, message, { idempotencyKey: `code:${IDEM_MARK}:slot1` });
    const second = mailer.send(TO, message, { idempotencyKey: `code:${IDEM_MARK}:slot2` });
    const results = await Promise.all([first, second]);
    await mailer.drain(2000);
    captured.results.push(...results);
    captured.lines.push(...rec.lines);
    captured.calls.push(...rec.calls);
    expect(results.map((r) => !r.ok && r.error.code)).toEqual(['email.timeout', 'email.timeout']);
    expect(s.connections).toBe(2);
    // Never two live connections: the second opened after the first one closed.
    const [firstClosed] = s.closedAt;
    const secondOpened = s.openedAt[1];
    expect(firstClosed).toBeDefined();
    expect(secondOpened).toBeGreaterThanOrEqual(firstClosed ?? Infinity);
  });
});

describe('what the failures left behind', () => {
  it('holds no address, password, key or reply text in any result, log line or metric', () => {
    expect(captured.results.length).toBeGreaterThanOrEqual(12);
    expect(captured.lines.length).toBeGreaterThanOrEqual(12);
    const text = JSON.stringify(captured);
    for (const secret of [
      TO,
      FROM,
      'example.com',
      credentials().password,
      IDEM_MARK,
      REPLY_SENTINEL,
      'try again',
      'later',
      'busy',
      'spam',
    ]) {
      expect(text, secret).not.toContain(secret);
    }
    for (const result of captured.results) {
      expect(result.ok ? '' : Object.keys(result.error).join()).not.toMatch(/message|stack/);
    }
  });
});

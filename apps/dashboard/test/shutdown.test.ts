import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { drainMailer, holdMailer } from '../src/server/mail-holder.ts';

const HOLDER = Symbol.for('drefyn.mailer');

describe('drainMailer', () => {
  it('resolves zero dropped with nothing held', async () => {
    Reflect.deleteProperty(globalThis, HOLDER);
    await expect(drainMailer(100)).resolves.toEqual({ dropped: 0 });
  });

  it('passes the deadline to the held mailer', async () => {
    Reflect.deleteProperty(globalThis, HOLDER);
    const seen: number[] = [];
    holdMailer(
      Promise.resolve({
        configured: true,
        send: () => Promise.reject(new Error('unused')),
        drain: (ms: number) => {
          seen.push(ms);
          return Promise.resolve({ dropped: 2 });
        },
      }),
    );
    await expect(drainMailer(8000)).resolves.toEqual({ dropped: 2 });
    expect(seen).toEqual([8000]);
  });

  it('never rejects when the held load failed', async () => {
    Reflect.deleteProperty(globalThis, HOLDER);
    holdMailer(Promise.reject(new Error('load failed')));
    await expect(drainMailer(100)).resolves.toEqual({ dropped: 0 });
  });
});

// A real process and a real signal, on the real test transport held open with hangNext.
const CHILD = `
import { createMailer } from '@drefyn/email';
import { createTestTransport } from '@drefyn/email/testing';
import { parseEmailConfig } from '@drefyn/email/config';
import { drainMailer, holdMailer } from './src/server/mail-holder.ts';
const transport = createTestTransport();
transport.hangNext();
const parsed = parseEmailConfig({
  DREFYN_EMAIL_TRANSPORT: 'smtp',
  DREFYN_EMAIL_FROM: 'drefyn@example.dev',
  DREFYN_SMTP_HOST: 'relay.example.dev',
  DREFYN_SMTP_TLS: 'none',
  DREFYN_SMTP_ALLOW_PLAINTEXT: 'true',
  DREFYN_SMTP_MAX_CONCURRENT: '1',
});
if (!parsed.ok) throw new Error(parsed.error.key);
const noop = () => undefined;
const mailer = createMailer(parsed.value, {
  linkOrigin: new URL('https://app.drefyn.test'),
  logger: { info: noop, warn: noop, error: noop },
  metrics: { counter: noop, histogram: noop, gauge: noop },
  transport,
});
holdMailer(Promise.resolve(mailer));
process.once('SIGTERM', async () => {
  const { dropped } = await drainMailer(200);
  process.stdout.write(JSON.stringify({ dropped }));
  process.exit(0);
});
const send = (key: string) =>
  void mailer.send('a@example.com', {
    template: 'sign_in_code', purpose: 'sign_in', code: '12345678',
    link: new URL('https://app.drefyn.test/sign-in/verify#x'), expiresInMinutes: 10,
  }, { idempotencyKey: key });
// One held open by the transport, which drain waits for, and two queued behind it.
for (const key of ['code:one', 'code:two', 'code:three']) send(key);
setTimeout(() => process.stdout.write('ready\\n'), 100);
`;

describe('SIGTERM', () => {
  it('drains in flight sends up to the deadline and counts what it dropped', async () => {
    const child = spawn(process.execPath, ['--input-type=module-typescript', '-e', CHILD], {
      cwd: new URL('..', import.meta.url),
      // As the server runs, since React's dev build warns about the mail's table attributes.
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let errors = '';
    let signalled = false;
    child.stderr.on('data', (chunk: Buffer) => (errors += chunk.toString('utf8')));
    const code = await new Promise<number | null>((done) => {
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
        if (!signalled && output.includes('ready')) {
          signalled = true;
          child.kill('SIGTERM');
        }
      });
      child.on('exit', done);
    });
    expect(errors).toBe('');
    expect(code).toBe(0);
    expect(output).toContain('{"dropped":2}');
  }, 30_000);
});

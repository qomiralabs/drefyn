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
import { drainMailer, holdMailer } from './src/server/mail-holder.ts';
const transport = createTestTransport();
transport.hangNext();
const config = {
  kind: 'smtp',
  sender: { from: 'drefyn@example.dev', fromName: 'Drefyn', headers: new Map() },
  limits: { maxConcurrent: 4, queueMax: 100 },
  smtp: { timeouts: { deadlineMs: 60000 } },
};
const noop = () => undefined;
const mailer = createMailer(config, {
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
void mailer.send('a@example.com', {
  template: 'sign_in_code', purpose: 'sign_in', code: '12345678',
  link: new URL('https://app.drefyn.test/sign-in/verify#x'), expiresInMinutes: 10,
}, { idempotencyKey: 'code:one' });
process.stdout.write('ready\\n');
`;

describe('SIGTERM', () => {
  it('drains in flight sends up to the deadline and counts what it dropped', async () => {
    const child = spawn(process.execPath, ['--input-type=module-typescript', '-e', CHILD], {
      cwd: new URL('..', import.meta.url),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let errors = '';
    child.stderr.on('data', (chunk: Buffer) => (errors += chunk.toString('utf8')));
    const code = await new Promise<number | null>((done) => {
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
        if (output.includes('ready')) child.kill('SIGTERM');
      });
      child.on('exit', done);
    });
    expect(errors).toBe('');
    expect(code).toBe(0);
    expect(output).toContain('{"dropped":1}');
  }, 30_000);
});

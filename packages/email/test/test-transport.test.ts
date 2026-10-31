import { describe, expect, it } from 'vitest';
import type { NormalizedEmailAddress } from '@drefyn/address';
import { renderMail, type Envelope, type RenderedMail } from '../src/index.ts';
import { createTestTransport } from '../src/testing.ts';
import { AT, ORIGIN, invitation, link, notice, signIn } from './support.ts';

const envelope = (patch: Partial<Envelope> = {}): Envelope => ({
  from: 'mail@drefyn.test' as NormalizedEmailAddress,
  fromName: 'Drefyn',
  to: 'person@example.com' as NormalizedEmailAddress,
  messageId: '<abc@drefyn.test>',
  idempotencyKey: 'code:1',
  headers: new Map(),
  ...patch,
});

async function mail(message: Parameters<typeof renderMail>[0]): Promise<RenderedMail> {
  const result = await renderMail(message, { linkOrigin: ORIGIN });
  if (!result.ok) throw new Error('render refused');
  return result.value;
}

const never = new AbortController().signal;

describe('createTestTransport', () => {
  it('captures template, purpose, parts, code and links for each send', async () => {
    const transport = createTestTransport();
    expect(transport.kind).toBe('test');
    const code = await mail(signIn({ code: '11223344' }));
    expect(await transport.deliver(envelope(), code, never)).toEqual({
      ok: true,
      value: { messageId: '<abc@drefyn.test>' },
    });
    const captured = transport.sent[0];
    expect(captured).toMatchObject({
      to: 'person@example.com',
      idempotencyKey: 'code:1',
      messageId: '<abc@drefyn.test>',
      template: 'sign_in_code',
      purpose: 'sign_in',
      subject: code.subject,
      html: code.html,
      text: code.text,
      code: '11223344',
    });
    expect(captured?.noticeKind).toBeUndefined();
    expect(captured?.links.map(String)).toEqual([link().href]);

    const notified = await mail(
      notice({ kind: 'new_device_sign_in', at: AT, sessionsLink: link('/settings/sessions') }),
    );
    await transport.deliver(envelope({ idempotencyKey: 'notice:user:e:u' }), notified, never);
    expect(transport.sent[1]).toMatchObject({
      template: 'security_notice',
      noticeKind: 'new_device_sign_in',
    });
    expect(transport.sent[1]?.code).toBeUndefined();
    expect(transport.sent[1]?.links.map(String)).toEqual([link('/settings/sessions').href]);

    await transport.deliver(envelope(), await mail(invitation()), never);
    expect(transport.sent[2]?.links.map(String)).toEqual([link('/invite').href]);
    expect(transport.sent).toHaveLength(3);
  });

  it('fails the next sends in order with the code and phase asked for', async () => {
    const transport = createTestTransport();
    const m = await mail(signIn());
    transport.failNext('email.rejected', 'data');
    transport.failNext('email.connect_failed');
    transport.failNext('email.deferred');
    expect(await transport.deliver(envelope(), m, never)).toEqual({
      ok: false,
      error: { code: 'email.rejected', phase: 'data', smtpReplyClass: 5 },
    });
    expect(await transport.deliver(envelope(), m, never)).toEqual({
      ok: false,
      error: { code: 'email.connect_failed', phase: 'connect' },
    });
    expect(await transport.deliver(envelope(), m, never)).toEqual({
      ok: false,
      error: { code: 'email.deferred', phase: 'envelope', smtpReplyClass: 4 },
    });
    expect((await transport.deliver(envelope(), m, never)).ok).toBe(true);
    expect(transport.sent).toHaveLength(1);
  });

  it('hangs until the signal aborts', async () => {
    const transport = createTestTransport();
    const controller = new AbortController();
    transport.hangNext();
    let settled = false;
    const pending = transport
      .deliver(envelope(), await mail(signIn()), controller.signal)
      .then((r) => {
        settled = true;
        return r;
      });
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    controller.abort();
    expect(await pending).toEqual({
      ok: false,
      error: { code: 'email.timeout', phase: 'connect' },
    });
    expect(transport.sent).toHaveLength(0);
  });

  it('returns at once when the signal is already aborted', async () => {
    const transport = createTestTransport();
    const controller = new AbortController();
    controller.abort();
    transport.hangNext();
    expect((await transport.deliver(envelope(), await mail(signIn()), controller.signal)).ok).toBe(
      false,
    );
  });

  it('reports progress up to the phase it hangs in, and the lost reply when it hangs after data', async () => {
    const transport = createTestTransport();
    const m = await mail(signIn());
    const cases = [
      [undefined, [], { code: 'email.timeout', phase: 'connect' }],
      ['connect', ['connect'], { code: 'email.timeout', phase: 'connect' }],
      ['auth', ['connect', 'auth'], { code: 'email.timeout', phase: 'auth' }],
      ['envelope', ['connect', 'auth', 'envelope'], { code: 'email.timeout', phase: 'envelope' }],
      [
        'data',
        ['connect', 'auth', 'envelope', 'data'],
        { code: 'email.unknown_outcome', phase: 'after_data' },
      ],
      [
        'after_data',
        ['connect', 'auth', 'envelope', 'data', 'after_data'],
        { code: 'email.unknown_outcome', phase: 'after_data' },
      ],
    ] as const;
    for (const [phase, reported, error] of cases) {
      const seen: string[] = [];
      const controller = new AbortController();
      transport.hangNext(phase);
      const pending = transport.deliver(envelope(), m, controller.signal, (p) => seen.push(p));
      await new Promise((r) => setImmediate(r));
      controller.abort();
      expect(await pending, String(phase)).toEqual({ ok: false, error });
      expect(seen, String(phase)).toEqual(reported);
    }
  });

  it('reports every phase on a send that goes through', async () => {
    const transport = createTestTransport();
    const seen: string[] = [];
    await transport.deliver(envelope(), await mail(signIn()), never, (p) => seen.push(p));
    expect(seen).toEqual(['connect', 'envelope', 'data', 'after_data']);
  });

  it('clears captures and planned outcomes', async () => {
    const transport = createTestTransport();
    const m = await mail(signIn());
    await transport.deliver(envelope(), m, never);
    transport.failNext('email.rejected');
    transport.clear();
    expect(transport.sent).toHaveLength(0);
    expect((await transport.deliver(envelope(), m, never)).ok).toBe(true);
    await expect(transport.close()).resolves.toBeUndefined();
  });

  it('hands out a copy of the captures, so a test cannot edit the record', async () => {
    const transport = createTestTransport();
    await transport.deliver(envelope(), await mail(signIn()), never);
    const first = transport.sent;
    (first as unknown[]).length = 0;
    expect(transport.sent).toHaveLength(1);
  });
});

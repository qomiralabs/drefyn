import type { Mailer, SendResult } from '@drefyn/email';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sent: SendResult = { ok: true, value: { messageId: 'm', attempts: 1 } };
const send = vi.fn<Mailer['send']>(() => Promise.resolve(sent));
const drain = vi.fn<Mailer['drain']>(() => Promise.resolve({ dropped: 0 }));
const createMailer = vi.fn(() => ({ configured: true, send, drain }));
const parseEmailConfig = vi.fn(() => ({ ok: true, value: { kind: 'smtp' } }));
const loadEmail = vi.fn(() => Promise.resolve({ createMailer, parseEmailConfig }));

vi.mock('../src/server/email-runtime.ts', () => ({ loadEmail }));

const LINK = new URL('https://app.drefyn.test/sign-in/verify#x.12345678');
const CHALLENGE = '01890a5d-ac96-774b-bcce-b302099a8073';
const deps = (enabled: () => Promise<boolean>) => ({
  linkOrigin: new URL('https://app.drefyn.test'),
  organizationName: () => Promise.resolve('Acme'),
  enabled,
});

const HOLDER = Symbol.for('drefyn.mailer');
let lines: string[];

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  Reflect.deleteProperty(globalThis, HOLDER);
  lines = [];
  for (const level of ['info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((line: string) => {
      lines.push(line);
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

const load = () => import('../src/server/auth-mailer.ts');
const logged = (event: string) => lines.filter((l) => l.includes(`"${event}"`)).length;

describe('with the flag off', () => {
  it('loads nothing and reports not configured', async () => {
    const { dashboardMail } = await load();
    const mail = await dashboardMail(deps(() => Promise.resolve(false)));
    expect(mail.configured).toBe(false);
    expect(loadEmail).not.toHaveBeenCalled();
    expect(createMailer).not.toHaveBeenCalled();
  });

  it('reads a flag client error as off', async () => {
    const { dashboardMail } = await load();
    const mail = await dashboardMail(deps(() => Promise.reject(new Error('flagd down'))));
    expect(mail.configured).toBe(false);
    expect(loadEmail).not.toHaveBeenCalled();
  });

  it('turns a send into a refused mail, which auth already logs', async () => {
    const { dashboardMail } = await load();
    const mail = await dashboardMail(deps(() => Promise.resolve(false)));
    await expect(
      mail.auth.sendSignInCode('a@example.com', '12345678', LINK, 'sign_in', CHALLENGE),
    ).rejects.toThrow('email.not_configured');
  });
});

describe('with the flag on', () => {
  it('uses the configured transport and logs that it is ready', async () => {
    const { dashboardMail } = await load();
    const mail = await dashboardMail(deps(() => Promise.resolve(true)));
    expect(mail.configured).toBe(true);
    await mail.auth.sendSignInCode('a@example.com', '12345678', LINK, 'sign_in', CHALLENGE);
    expect(send).toHaveBeenCalledOnce();
    expect(logged('dashboard.email_ready')).toBe(1);
  });

  it('holds one mailer for the process, whichever module copy asks', async () => {
    const first = await load();
    await first.dashboardMail(deps(() => Promise.resolve(true)));
    vi.resetModules();
    const second = await load();
    await second.dashboardMail(deps(() => Promise.resolve(true)));
    expect(createMailer).toHaveBeenCalledOnce();
    expect(logged('dashboard.email_ready')).toBe(1);
  });

  it('reads the flag once', async () => {
    const enabled = vi.fn(() => Promise.resolve(true));
    const { dashboardMail } = await load();
    await dashboardMail(deps(enabled));
    await dashboardMail(deps(enabled));
    expect(enabled).toHaveBeenCalledOnce();
  });

  it('reports not configured with no transport set', async () => {
    createMailer.mockReturnValueOnce({ configured: false, send, drain });
    const { dashboardMail } = await load();
    expect((await dashboardMail(deps(() => Promise.resolve(true)))).configured).toBe(false);
  });

  it('never rejects on a failed load, and a later call tries again', async () => {
    loadEmail.mockRejectedValueOnce(new Error('ERR_MODULE_NOT_FOUND /secret/path'));
    const { dashboardMail } = await load();
    const failed = await dashboardMail(deps(() => Promise.resolve(true)));
    expect(failed.configured).toBe(false);
    expect(logged('dashboard.email_load_failed')).toBe(1);
    expect(lines.join('\n')).not.toContain('/secret/path');
    const again = await dashboardMail(deps(() => Promise.resolve(true)));
    expect(again.configured).toBe(true);
  });

  it('reads a bad mail config as a failed load', async () => {
    parseEmailConfig.mockReturnValueOnce({ ok: false, value: { kind: 'smtp' } });
    const { dashboardMail } = await load();
    const mail = await dashboardMail(deps(() => Promise.resolve(true)));
    expect(mail.configured).toBe(false);
    expect(logged('dashboard.email_load_failed')).toBe(1);
  });
});

describe('with email sign in on and nothing to send through', () => {
  it('logs dashboard.email_off once across calls', async () => {
    const { dashboardMail, noteEmailOff } = await load();
    const mail = await dashboardMail(deps(() => Promise.resolve(false)));
    noteEmailOff(mail, 'auto');
    noteEmailOff(mail, 'on');
    expect(logged('dashboard.email_off')).toBe(1);
  });

  it('says nothing when email sign in is off or a transport is set', async () => {
    const { dashboardMail, noteEmailOff } = await load();
    noteEmailOff(await dashboardMail(deps(() => Promise.resolve(false))), 'off');
    expect(logged('dashboard.email_off')).toBe(0);
    noteEmailOff({ configured: true, auth: {} as never }, 'on');
    expect(logged('dashboard.email_off')).toBe(0);
  });
});

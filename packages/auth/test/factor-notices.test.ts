import { toPublicId } from '@drefyn/tenancy';
import { describe, expect, it, vi } from 'vitest';
import { AuthError, type AuthSecurityNotice } from '../src/index.ts';
import { sendFactorAlert, sendFactorNotice, startNow } from '../src/factor-notices.ts';
import { scriptedStore } from './scripted-store.ts';
import { USER, capturingLogger, noopLimiter } from './session-fixtures.ts';

const AT = new Date('2026-11-16T10:00:00.000Z');

function deps(options: { email?: string | null; reserve?: () => Promise<void> } = {}) {
  const email = options.email === undefined ? 'person@example.com' : options.email;
  const scripted = scriptedStore((s) =>
    s.sql.includes('from "users"') && email !== null ? [{ email }] : [],
  );
  const { logger, lines } = capturingLogger();
  const limiter = noopLimiter();
  if (options.reserve !== undefined) limiter.reserve = options.reserve;
  const sent: { to: string; notice: AuthSecurityNotice }[] = [];
  const mailer = {
    sendSecurityNotice(to: string, notice: AuthSecurityNotice) {
      sent.push({ to, notice });
      return Promise.resolve();
    },
  };
  return {
    deps: { store: scripted.store, limiter, logger, mailer },
    scripted,
    lines,
    sent,
    limiter,
  };
}

describe('sendFactorNotice', () => {
  it('reads the address under the person when none is given', async () => {
    const { deps: d, sent, scripted } = deps();
    await sendFactorNotice(d, USER, { kind: 'second_factor_removed', at: AT });
    expect(sent).toEqual([
      { to: 'person@example.com', notice: { kind: 'second_factor_removed', at: AT } },
    ]);
    expect(scripted.events[0]).toEqual({ kind: 'begin', scope: 'user', userId: USER });
  });

  it('uses the address it is given without a read', async () => {
    const { deps: d, sent, scripted } = deps();
    await sendFactorNotice(d, USER, { kind: 'second_factor_added', at: AT }, 'a@example.com');
    expect(sent.map((m) => m.to)).toEqual(['a@example.com']);
    expect(scripted.statements()).toEqual([]);
  });

  it.each([
    ['no mailer', { mailer: {} }],
    [
      'a mailer that fails',
      { mailer: { sendSecurityNotice: () => Promise.reject(new Error('down')) } },
    ],
  ])('never throws with %s, and logs ids only', async (_name, patch) => {
    const { deps: d, lines } = deps();
    await expect(
      sendFactorNotice({ ...d, ...patch }, USER, { kind: 'second_factor_added', at: AT }),
    ).resolves.toBeUndefined();
    expect(lines).toEqual([
      {
        event: 'auth.factor_notice_failed',
        fields: { kind: 'second_factor_added', userId: toPublicId('usr', USER) },
      },
    ]);
  });

  it('sends nothing for a person with no address', async () => {
    const { deps: d, sent, lines } = deps({ email: null });
    await sendFactorNotice(d, USER, { kind: 'second_factor_added', at: AT });
    expect(sent).toEqual([]);
    expect(lines.map((l) => l.event)).toEqual(['auth.factor_notice_failed']);
  });
});

describe('sendFactorAlert', () => {
  it('counts the failure notice against the person and sends it', async () => {
    const { deps: d, sent, limiter } = deps();
    await sendFactorAlert(d, USER, { kind: 'second_factor_failures', at: AT });
    expect(limiter.calls).toEqual([['second_factor_notice', [USER]]]);
    expect(sent.map((m) => m.notice)).toEqual([{ kind: 'second_factor_failures', at: AT }]);
  });

  it('sends nothing once the cap is reached, and says so quietly', async () => {
    const {
      deps: d,
      sent,
      lines,
    } = deps({
      reserve: () => Promise.reject(new AuthError('AUTH_RATE_LIMITED')),
    });
    await sendFactorAlert(d, USER, { kind: 'second_factor_failures', at: AT });
    expect(sent).toEqual([]);
    expect(lines).toEqual([
      {
        event: 'auth.factor_notice_capped',
        fields: { kind: 'second_factor_failures', userId: toPublicId('usr', USER) },
      },
    ]);
  });

  it('sends nothing when the limiter is down, and warns', async () => {
    const {
      deps: d,
      sent,
      lines,
    } = deps({
      reserve: () => Promise.reject(new Error('pool exhausted')),
    });
    await sendFactorAlert(d, USER, { kind: 'second_factor_failures', at: AT });
    expect(sent).toEqual([]);
    expect(lines.map((l) => l.event)).toEqual(['auth.factor_notice_failed']);
  });

  it('always sends the ceiling notice, outside the cap', async () => {
    const {
      deps: d,
      sent,
      limiter,
    } = deps({
      reserve: () => Promise.reject(new AuthError('AUTH_RATE_LIMITED')),
    });
    await sendFactorAlert(d, USER, { kind: 'second_factor_disabled', at: AT });
    expect(limiter.calls).toEqual([]);
    expect(sent.map((m) => m.notice.kind)).toEqual(['second_factor_disabled']);
  });
});

describe('startNow', () => {
  it('starts the task without waiting for it', () => {
    const task = vi.fn(() => new Promise<void>(() => undefined));
    startNow(task);
    expect(task).toHaveBeenCalledTimes(1);
  });
});

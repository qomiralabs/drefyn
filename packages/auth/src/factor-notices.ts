import type { UserId } from '@drefyn/tenancy';
import { sql } from 'kysely';
import type { AuthNoticeMailer, AuthSecurityNotice } from './email-change.ts';
import { AuthError } from './errors.ts';
import { factorNoticeLimit } from './factor-limits.ts';
import type { FactorAlert } from './factor-verify.ts';
import type { AuthLogger, RateLimiter } from './rate-limiter.ts';
import { idFields, quietInfo, quietWarn, type SessionStore } from './session-support.ts';

// Work that must not hold up the answer to a failed attempt. The default starts it and lets
// it run; a test hands in its own to wait for it.
export type Later = (task: () => Promise<void>) => void;

export const startNow: Later = (task) => {
  void task();
};

export interface FactorNoticeDeps {
  readonly store: Pick<SessionStore, 'user'>;
  readonly limiter: Pick<RateLimiter, 'reserve'>;
  readonly logger: AuthLogger;
  readonly mailer: Partial<AuthNoticeMailer>;
}

type FactorNotice = Extract<
  AuthSecurityNotice,
  {
    readonly kind:
      | 'second_factor_added'
      | 'second_factor_removed'
      | 'recovery_code_used'
      | 'recovery_codes_replaced'
      | 'second_factor_failures'
      | 'second_factor_disabled';
  }
>;

// Mails one notice and never throws: a security action has already happened or been
// refused, and a mail outage must not change that. The address is read only when the
// caller has none, as on a failed sign in where no session exists yet.
export async function sendFactorNotice(
  deps: FactorNoticeDeps,
  userId: UserId,
  notice: FactorNotice,
  to?: string,
): Promise<void> {
  const fields = { kind: notice.kind, ...idFields({ userId: ['usr', userId] }) };
  try {
    const send = deps.mailer.sendSecurityNotice;
    if (send === undefined) throw new AuthError('AUTH_UNAVAILABLE');
    const address = to ?? (await addressOf(deps.store, userId));
    if (address === null) throw new AuthError('AUTH_NOT_FOUND');
    await send.call(deps.mailer, address, notice);
  } catch {
    quietWarn(deps.logger, 'auth.factor_notice_failed', fields);
  }
}

// The failure notice goes out at most once per window per person, so an attacker cannot
// flood the owner's inbox, and the owner still hears within hours. Reaching the ceiling is
// always sent: it changes how the person signs in.
export async function sendFactorAlert(
  deps: FactorNoticeDeps,
  userId: UserId,
  alert: FactorAlert,
): Promise<void> {
  if (alert.kind === 'second_factor_failures') {
    const { bucket, value } = factorNoticeLimit(userId);
    try {
      await deps.limiter.reserve(bucket, value);
    } catch (error) {
      const limited = error instanceof AuthError && error.code === 'AUTH_RATE_LIMITED';
      const fields = { kind: alert.kind, ...idFields({ userId: ['usr', userId] }) };
      if (limited) quietInfo(deps.logger, 'auth.factor_notice_capped', fields);
      else quietWarn(deps.logger, 'auth.factor_notice_failed', fields);
      return;
    }
  }
  await sendFactorNotice(deps, userId, { kind: alert.kind, at: alert.at });
}

async function addressOf(store: Pick<SessionStore, 'user'>, userId: UserId) {
  const row = await store.user(userId, (tx) =>
    tx
      .selectFrom('users')
      .select('email')
      .where('id', '=', sql<string>`app.current_user_id()`)
      .executeTakeFirst(),
  );
  return row?.email ?? null;
}

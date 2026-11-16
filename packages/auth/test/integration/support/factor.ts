import { randomBytes } from 'node:crypto';
import { withUser } from '@drefyn/db';
import type { UserId } from '@drefyn/tenancy';
import {
  createFactorChallenges,
  decodeSecret,
  encodeSecret,
  formBindingField,
  newRecoveryCodes,
  parseAuthConfig,
  totpCode,
  type AuthConfig,
  type FactorChallengesDeps,
  type FactorKind,
} from '../../../src/index.ts';
import { base64url, validEnv } from '../../support.ts';
import { ROOMY_PASSWORD_LIMITS, loggerFor } from './passwords.ts';
import type { Browser } from './email.ts';
import type { Harness } from './harness.ts';

export const TOTP_SECRET = Buffer.alloc(20, 4);
export const TOTP_KEYS = `k1:${base64url(new Uint8Array(32).fill(21))}`;

// Limits wide enough that only a test about a limit meets one.
export const ROOMY_FACTOR_LIMITS = {
  ...ROOMY_PASSWORD_LIMITS,
  DREFYN_AUTH_RATE_TOTP_VERIFY: '1000/1h',
  DREFYN_AUTH_RATE_RECOVERY_CODE_VERIFY: '1000/1h',
  DREFYN_AUTH_RATE_RECOVERY_CODE_VERIFY_IP: '1000/1h',
  DREFYN_AUTH_RATE_OAUTH_START: '1000/10m',
} as const;

export function factorConfig(env: Readonly<Record<string, string>> = {}): AuthConfig {
  return parseAuthConfig({
    ...validEnv(randomBytes(32).toString('base64url')),
    ...ROOMY_FACTOR_LIMITS,
    DREFYN_AUTH_TOTP_KEYS: TOTP_KEYS,
    DREFYN_AUTH_SIGNUP: 'open',
    ...env,
  });
}

// What an enrolment leaves behind, written the way #321's confirm will: under the person's
// own context, holding the factor lock exclusive.
export async function enroll(
  h: Harness,
  userId: UserId,
  config: AuthConfig,
): Promise<readonly string[]> {
  const sealer = config.totp.sealer ?? factorConfig().totp.sealer;
  if (sealer === null) throw new Error('no sealer');
  const sealed = sealer.seal(TOTP_SECRET, { userId });
  const codes = newRecoveryCodes(userId);
  await withUser(h.db, { userId }, async (tx) => {
    await tx
      .insertInto('totp_credentials')
      .values({
        user_id: userId,
        key_id: sealed.keyId,
        secret_nonce: sealed.nonce,
        secret_sealed: sealed.sealed,
        confirmed_at: new Date(),
        last_used_step: null,
        last_used_at: null,
        failed_attempts: 0,
      })
      .execute();
    await tx
      .insertInto('recovery_codes')
      .values(codes.map((c) => ({ user_id: userId, code_hash: c.hash })))
      .execute();
  });
  return codes.map((c) => c.code);
}

// The code an app shows now, by the database clock the verify reads.
export async function currentCode(h: Harness): Promise<string> {
  const step = Number(await h.sql('select floor(extract(epoch from now()) / 30)::int;'));
  return totpCode(TOTP_SECRET, step);
}

export const wrongTotp = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

export function challengesFor(
  h: Harness,
  config: AuthConfig,
  extra: Partial<FactorChallengesDeps> = {},
) {
  return createFactorChallenges(config, {
    db: h.db,
    authDb: h.authDb,
    logger: loggerFor(h),
    mailer: h.mail.mailer,
    ...extra,
  });
}

// The challenge form as the page posts it, bound to the browser's pre sign in cookie. A
// browser without one gets one first, as the page's mint route gives it.
export function factorPost(
  config: AuthConfig,
  browser: Pick<Browser, 'cookies'>,
  kind: FactorKind,
  code: string,
) {
  let pre = decodeSecret(browser.cookies.get(config.cookies.pre));
  if (pre === null) {
    pre = randomBytes(32);
    browser.cookies.set(config.cookies.pre, encodeSecret(pre));
  }
  return { kind, code, csrf: formBindingField(config, pre) };
}

export const count = async (h: Harness, sql: string) =>
  Number(await h.sql(`select count(*) from ${sql};`));

export const sessionsOf = (h: Harness, userId: UserId) =>
  count(h, `app.sessions where user_id = '${userId}'`);
export const challengesOf = (h: Harness, userId: UserId) =>
  count(h, `app.factor_challenges where user_id = '${userId}'`);
export const unusedCodesOf = (h: Harness, userId: UserId) =>
  count(h, `app.recovery_codes where user_id = '${userId}' and used_at is null`);

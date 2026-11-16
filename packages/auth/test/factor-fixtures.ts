import type { AuthDatabase, Database } from '@drefyn/db';
import type { UserId } from '@drefyn/tenancy';
import {
  createFactorChallenges,
  formatFactorToken,
  formBindingField,
  newRecoveryCodes,
  parseAuthConfig,
  totpCode,
  type AuthConfig,
  type AuthMetrics,
  type FactorChallengesDeps,
} from '../src/index.ts';
import { encodeSecret } from '../src/tokens.ts';
import { scriptedStore, type Responder, type Statement } from './scripted-store.ts';
import { capturingLogger, noopLimiter, sha, USER } from './session-fixtures.ts';
import { base64url, validEnv } from './support.ts';

export const TOTP_KEY = `k1:${base64url(new Uint8Array(32).fill(21))}`;
export const factorConfig: AuthConfig = parseAuthConfig({
  ...validEnv(),
  DREFYN_AUTH_TOTP_KEYS: TOTP_KEY,
});
// The same deployment with the key taken away, for the fail closed case.
export const keylessConfig: AuthConfig = parseAuthConfig(validEnv());

export const TOTP_SECRET = Buffer.alloc(20, 4);
export const CHALLENGE_SECRET = Buffer.alloc(32, 8);
export const PRE = Buffer.alloc(32, 6);
// A step whose code and the one before differ, picked so the tests never depend on the clock.
export const STEP = 59_000_000;

export const codeAt = (step: number) => totpCode(TOTP_SECRET, step);
// Database time as the credential read reports it.
export const FACTOR_NOW = new Date('2026-11-16T10:00:00.000Z');
export const RECOVERY = newRecoveryCodes(USER);

export function sealedRow(config: AuthConfig = factorConfig, user: UserId = USER) {
  const sealer = config.totp.sealer ?? factorConfig.totp.sealer;
  if (sealer === null) throw new Error('the fixture config has a key');
  return sealer.seal(TOTP_SECRET, { userId: user });
}

export const factorCookie = (user: UserId = USER, secret: Uint8Array = CHALLENGE_SECRET) =>
  formatFactorToken({ userId: user, secret });

export function factorBrowser(
  config: AuthConfig = factorConfig,
  cookies: Record<string, string> = {},
) {
  return {
    ip: '2001:db8:1:2::7',
    userAgent: 'Mozilla/5.0 (test)',
    cookies: new Map(
      Object.entries({
        [config.cookies.factor]: factorCookie(),
        [config.cookies.pre]: base64Pre(),
        ...cookies,
      }),
    ),
  };
}

export const csrfFor = (config: AuthConfig = factorConfig) => formBindingField(config, PRE);

// The pre cookie is the canonical 52 symbol encoding the form binding reads back.
const base64Pre = (): string => encodeSecret(PRE);

export interface ChallengeShape {
  readonly secret?: Uint8Array;
  readonly live?: boolean;
  readonly method?: string;
  readonly returnTo?: string | null;
}

export function challengeRow(shape: ChallengeShape = {}): Record<string, unknown> {
  return {
    secret_hash: sha(shape.secret ?? CHALLENGE_SECRET),
    method: shape.method ?? 'password',
    return_to: shape.returnTo === undefined ? '/docs' : shape.returnTo,
    sso_connection_id: null,
    sso_organization_id: null,
    live: shape.live ?? true,
  };
}

export interface CredentialShape {
  readonly failed?: number;
  readonly lastUsedStep?: number | null;
  readonly keyId?: string;
  readonly confirmed?: boolean;
}

export function credentialRow(shape: CredentialShape = {}): Record<string, unknown> {
  const sealed = sealedRow();
  return {
    key_id: shape.keyId ?? sealed.keyId,
    secret_nonce: sealed.nonce,
    secret_sealed: sealed.sealed,
    last_used_step: shape.lastUsedStep === undefined ? null : shape.lastUsedStep,
    failed_attempts: shape.failed ?? 0,
    confirmed: shape.confirmed ?? true,
    step: STEP,
    now: FACTOR_NOW,
  };
}

const select = (s: Statement, table: string) =>
  /^select\b/i.test(s.sql) && s.sql.includes(`from "${table}"`);
export const isChallengeRead = (s: Statement) => select(s, 'factor_challenges');
export const isFactorLock = (s: Statement) => s.sql.includes('pg_advisory_xact_lock');
export const isAttemptCount = (s: Statement) =>
  /^update "factor_challenges"/i.test(s.sql) && s.sql.includes('"attempts"');
export const isCredentialRead = (s: Statement) => select(s, 'totp_credentials');
export const isRecoveryRead = (s: Statement) => select(s, 'recovery_codes');
export const isStepWrite = (s: Statement) =>
  /^update "totp_credentials"/i.test(s.sql) && s.sql.includes('"last_used_step" =');
export const isFailureWrite = (s: Statement) =>
  /^update "totp_credentials"/i.test(s.sql) && s.sql.includes('least(');
export const isRecoverySpend = (s: Statement) => /^update "recovery_codes"/i.test(s.sql);
export const isChallengeDelete = (s: Statement) => /^delete from "factor_challenges"/i.test(s.sql);
export const isChallengeInsert = (s: Statement) => /^insert into "factor_challenges"/i.test(s.sql);
export const isSessionInsert = (s: Statement) => /^insert into "sessions"/i.test(s.sql);

export interface WorldShape {
  readonly challenge?: Record<string, unknown> | null;
  readonly credential?: Record<string, unknown> | null;
  readonly recovery?: readonly { id: string; code_hash: Buffer }[];
  // The conditional writes: false answers no row, as a lost race or a replay would.
  readonly attemptCounted?: boolean;
  readonly stepMoved?: boolean;
  readonly recoverySpent?: boolean;
  readonly failedTo?: number;
}

export function factorResponder(shape: WorldShape = {}): Responder {
  const challenge = shape.challenge === undefined ? challengeRow() : shape.challenge;
  const credential = shape.credential === undefined ? credentialRow() : shape.credential;
  return (s) => {
    if (isChallengeRead(s)) return challenge === null ? [] : [challenge];
    if (isAttemptCount(s)) {
      if (shape.attemptCounted === false || challenge === null) return [];
      return [challenge];
    }
    if (isCredentialRead(s)) return credential === null ? [] : [credential];
    if (isStepWrite(s)) return shape.stepMoved === false ? [] : [{ user_id: USER }];
    if (isFailureWrite(s)) return [{ failed_attempts: shape.failedTo ?? 1 }];
    if (isRecoveryRead(s)) {
      return (
        shape.recovery ?? RECOVERY.map((r, i) => ({ id: `r${String(i)}`, code_hash: r.hash }))
      ).slice();
    }
    if (isRecoverySpend(s)) return shape.recoverySpent === false ? [] : [{ id: 'r0' }];
    if (isChallengeDelete(s)) return challenge === null ? [] : [{ user_id: USER }];
    if (isSessionInsert(s)) {
      return [
        {
          id: '01890a5d-ac96-774b-bcce-b302099a8099',
          authenticated_at: new Date('2026-11-16T10:00:00.000Z'),
          expires_at: new Date('2026-12-16T10:00:00.000Z'),
        },
      ];
    }
    if (/^select\b/i.test(s.sql) && s.sql.includes('from "users"')) {
      return [{ email: 'person@example.com' }];
    }
    return [];
  };
}

export function countingMetrics() {
  const counted: { name: string; labels: unknown }[] = [];
  const metrics: AuthMetrics = {
    increment(name, labels) {
      counted.push({ name, labels });
    },
  };
  return { metrics, counted };
}

export function factorSetup(
  respond: Responder = factorResponder(),
  config: AuthConfig = factorConfig,
  extra: Partial<FactorChallengesDeps> = {},
) {
  const scripted = scriptedStore(respond);
  const { logger, lines } = capturingLogger();
  const limiter = noopLimiter();
  const { metrics, counted } = countingMetrics();
  const sent: unknown[] = [];
  const challenges = createFactorChallenges(config, {
    db: {} as Database,
    authDb: {} as AuthDatabase,
    logger,
    limiter,
    metrics,
    store: scripted.store,
    mailer: {
      sendSecurityNotice(to, notice) {
        sent.push({ to, notice });
        return Promise.resolve();
      },
    },
    random: (n) => Buffer.alloc(n, 5),
    ...extra,
  });
  return { challenges, scripted, lines, limiter, counted, sent };
}
